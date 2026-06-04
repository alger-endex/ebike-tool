/**
 * ble_bridge.ino — ESP32-H2 BLE ↔ UART transparent bridge
 *
 * 資料流:
 *   Browser → BLE Write (RX char) → RxCallbacks → motorSerial TX → 馬達控制器
 *   馬達控制器 → motorSerial RX → txBuf → BLE Notify (TX char) → Browser
 *
 * TX batching: UART 收到的 bytes 先暫存，累積到沒有新資料超過 BATCH_MS (5ms)
 * 或 buffer 滿才一次發 BLE notification，確保一個協議 frame 在同一個封包送出。
 *
 * 接線 (ESP32-H2 DevKit):
 *   GPIO4 (TX) → 馬達控制器 RX
 *   GPIO5 (RX) ← 馬達控制器 TX
 *   GND        ─ 馬達控制器 GND
 *
 * 環境:
 *   Arduino IDE 2.x + esp32 core 2.0.x 以上 (含 NimBLE)
 *   Board: "ESP32H2 Dev Module"
 *
 * BLE NUS UUIDs (對應 ble.js):
 *   Service : 6E400001-B5A3-F393-E0A9-E50E24DCCA9E
 *   RX char : 6E400002  (browser → write → ESP32 → UART TX)
 *   TX char : 6E400003  (UART RX → ESP32 → notify → browser)
 *   CFG char: 6E400004  (browser → write → 設定 UART baud rate)
 */

#include <NimBLEDevice.h>
#include <HardwareSerial.h>

// ── 設定 ─────────────────────────────────────────────────────
#define MOTOR_RX_PIN   5
#define MOTOR_TX_PIN   4
#define MOTOR_UART_NUM 1
#define DEFAULT_BAUD   115200

// TX batching: 超過此毫秒數沒有新 UART byte 就立即 notify
#define BATCH_MS       5

// ── BLE UUIDs ────────────────────────────────────────────────
#define SERVICE_UUID  "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define CHAR_UUID_RX  "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define CHAR_UUID_TX  "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
#define CHAR_UUID_CFG "6e400004-b5a3-f393-e0a9-e50e24dcca9e"

// ── 全域變數 ──────────────────────────────────────────────────
HardwareSerial motorSerial(MOTOR_UART_NUM);

NimBLEServer*         pServer = nullptr;
NimBLECharacteristic* pTxChar = nullptr;   // notify → browser

volatile bool bleConnected = false;
uint32_t      currentBaud  = DEFAULT_BAUD;

// TX 緩衝區 (UART → BLE)
static uint8_t  txBuf[512];
static size_t   txBufLen  = 0;
static uint32_t lastRxMs  = 0;

// ── CFG characteristic: 設定 UART baud rate ──────────────────
class CfgCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar) override {
    const std::string& val = pChar->getValue();
    if (val.size() < 5) return;
    const uint8_t* d = (const uint8_t*)val.data();
    if (d[0] != 0x01) return;
    uint32_t baud = (uint32_t)d[1]
                  | ((uint32_t)d[2] << 8)
                  | ((uint32_t)d[3] << 16)
                  | ((uint32_t)d[4] << 24);
    if (baud < 1200 || baud > 921600 || baud == currentBaud) return;
    currentBaud = baud;
    motorSerial.updateBaudRate(baud);
  }
};

// ── RX characteristic: browser → UART TX ────────────────────
class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar) override {
    const std::string& val = pChar->getValue();
    if (val.size() > 0) {
      motorSerial.write((const uint8_t*)val.data(), val.size());
      motorSerial.flush();   // 確保 bytes 立即送出
    }
  }
};

// ── BLE 連線 / 斷線 ──────────────────────────────────────────
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*) override {
    bleConnected = true;
    txBufLen = 0;
  }
  void onDisconnect(NimBLEServer*) override {
    bleConnected = false;
    txBufLen = 0;
    NimBLEDevice::startAdvertising();
  }
};

// ── Setup ────────────────────────────────────────────────────
void setup() {
  motorSerial.begin(DEFAULT_BAUD, SERIAL_8N1, MOTOR_RX_PIN, MOTOR_TX_PIN);
  motorSerial.setTimeout(10);   // readBytes timeout 改短，避免阻塞

  NimBLEDevice::init("ESP_GATTS_DEMO");
  NimBLEDevice::setMTU(512);

  pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  NimBLEService* pSvc = pServer->createService(SERVICE_UUID);

  // TX char: notify browser with UART received data
  pTxChar = pSvc->createCharacteristic(CHAR_UUID_TX, NIMBLE_PROPERTY::NOTIFY);

  // RX char: receive writes from browser, forward to UART
  NimBLECharacteristic* pRxChar = pSvc->createCharacteristic(
    CHAR_UUID_RX, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
  );
  pRxChar->setCallbacks(new RxCallbacks());

  // CFG char: receive baud rate config from browser
  NimBLECharacteristic* pCfgChar = pSvc->createCharacteristic(
    CHAR_UUID_CFG, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
  );
  pCfgChar->setCallbacks(new CfgCallbacks());

  pSvc->start();

  NimBLEAdvertising* pAdv = NimBLEDevice::getAdvertising();
  pAdv->addServiceUUID(SERVICE_UUID);
  pAdv->setScanResponse(true);
  pAdv->start();
}

// ── Loop: UART RX → txBuf → BLE notify ──────────────────────
//
// 設計:
//   1. 以非阻塞方式 (read()) 逐 byte 讀入 txBuf
//   2. 每收到一個 byte 更新 lastRxMs
//   3. 當沒有新 byte 超過 BATCH_MS，或 txBuf 已滿 → 一次 notify
//      → 確保單一協議 frame 在同一個 BLE 封包送出
// ─────────────────────────────────────────────────────────────
void loop() {
  if (!bleConnected) {
    // 清空 UART 緩衝避免累積舊資料
    while (motorSerial.available()) motorSerial.read();
    txBufLen = 0;
    return;
  }

  // Step 1: 非阻塞讀取所有可用 UART bytes
  while (motorSerial.available() > 0 && txBufLen < sizeof(txBuf)) {
    txBuf[txBufLen++] = (uint8_t)motorSerial.read();
    lastRxMs = millis();
  }

  // Step 2: 判斷是否送出 BLE notification
  if (txBufLen == 0) return;

  bool bufFull    = (txBufLen >= sizeof(txBuf));
  bool frameReady = (millis() - lastRxMs >= BATCH_MS);

  if (!bufFull && !frameReady) return;

  // Step 3: 發送 (最大 512 bytes per notification，對應 BLE MTU)
  size_t offset = 0;
  while (offset < txBufLen) {
    size_t chunk = min((size_t)512, txBufLen - offset);
    pTxChar->setValue(txBuf + offset, chunk);
    pTxChar->notify();
    offset += chunk;
  }
  txBufLen = 0;
}
