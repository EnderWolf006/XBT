<template>
  <div class="bg">
    <video ref="video" id="video" autoplay>
    </video>

    <!-- 缩放控制滑杆 -->
    <div class="zoom-control" v-if="zoomSupported">
      <div class="zoom-slider-container">
        <div class="zoom-label">缩放</div>
        <input
          type="range"
          class="zoom-slider"
          :min="zoomCapabilities.min"
          :max="zoomCapabilities.max"
          :step="zoomCapabilities.step"
          v-model="currentZoom"
          @input="onZoomChange"
        />
        <div class="zoom-value">{{ Math.round(currentZoom * 10) / 10 }}x</div>
      </div>
    </div>

    <div class="tip">{{ form.tipMsg }}</div>

    <!-- 位置选择区域 - 在最底部 -->
    <div class="location-control">
      <div class="location-container">
        <div class="location-toggle" @click="toggleLocation">
          <div class="custom-switch" :class="{ active: enableLocation }">
            <div class="switch-thumb"></div>
          </div>
          <span class="location-label">添加位置信息</span>
        </div>
        <div v-if="enableLocation" class="location-selector" @click="onSelectLocation">
          <var-icon name="map-marker-radius" size="16" />
          <span class="location-text">{{ locationText }}</span>
          <var-icon name="chevron-right" size="16" />
        </div>
      </div>
    </div>
  </div>

</template>
<script setup>
import { ref, onUnmounted, reactive, onMounted, watch, computed } from 'vue'
import { BrowserMultiFormatReader } from '@zxing/library'
import { Snackbar, Picker } from '@varlet/ui'
import { locationPreset } from '@/utils/constants'

const props = defineProps({
  signCallBack: {
    type: Function,
    default: (data) => { },
  },
  // 新增：是否启用智能监控模式
  enableSmartMonitoring: {
    type: Boolean,
    default: false,
  }
})

// 新增：暴露给父组件的方法
const emit = defineEmits(['qrCodeUpdated', 'latestQrData'])

const form = reactive({
  tipMsg: '尝试识别中...'
})

// 缩放相关状态
const video = ref(null)
const currentZoom = ref(1)
const zoomSupported = ref(false)
const zoomCapabilities = ref({
  min: 1,
  max: 3,
  step: 0.1
})
const videoTrack = ref(null)

// 新增：智能监控相关状态
const latestQrData = ref(null)
const qrHistory = ref([])
const monitoringInterval = ref(null)
const isMonitoring = ref(false)

// 新增：位置选择相关状态
const enableLocation = ref(false)
const selectedLocationIndex = ref(-1)

// 计算属性：位置显示文本
const locationText = computed(() => {
  if (selectedLocationIndex.value === -1) {
    return '点击选择位置';
  }
  return locationPreset[selectedLocationIndex.value].name;
})

function onScaned(text) {
  if (!text.includes("mobilelearn.chaoxing.com")) {
    form.tipMsg = '请扫描学习通二维码'
    return
  }

  const enc = text.split('&enc=')[1].split('&')[0];
  const c = text.split('&c=')[1].split('&')[0];
  const timestamp = Date.now();

  const newQrData = { enc, c, timestamp, rawText: text };

  // 更新最新的二维码数据
  latestQrData.value = newQrData;

  // 检查是否是新的二维码数据
  const isNewQrCode = !qrHistory.value.length || qrHistory.value[qrHistory.value.length - 1].enc !== enc;

  if (isNewQrCode) {
    qrHistory.value.push(newQrData);

    // 保持历史记录在合理范围内
    if (qrHistory.value.length > 10) {
      qrHistory.value = qrHistory.value.slice(-10);
    }

    // 通知父组件二维码已更新
    emit('qrCodeUpdated', newQrData);
    console.log('二维码更新:', { enc, timestamp: new Date(timestamp).toLocaleTimeString() });
  }

  // 无论是否为智能监控模式，都要执行签到回调
  // 智能监控模式下也需要触发签到流程
  form.tipMsg = '扫码成功'
  console.log('触发签到回调，智能监控模式:', props.enableSmartMonitoring, 'enc:', enc.substring(0, 8) + '...');

  // 构建签到数据
  const signData = { enc, c };

  // 如果启用了位置信息且已选择位置，添加位置参数
  if (enableLocation.value && selectedLocationIndex.value !== -1) {
    const selectedLocation = locationPreset[selectedLocationIndex.value];
    signData.location = {
      result: 1,
      latitude: parseFloat(selectedLocation.lat),
      longitude: parseFloat(selectedLocation.lng),
      mockData: {
        name: selectedLocation.name,
        description: selectedLocation.description
      },
      address: selectedLocation.description
    };
    console.log('添加位置信息:', selectedLocation.name);
  }

  props.signCallBack(signData)
}

// 新增：切换位置功能
function toggleLocation() {
  enableLocation.value = !enableLocation.value;
  if (!enableLocation.value) {
    selectedLocationIndex.value = -1; // 关闭时重置选择
  }
  console.log('位置功能:', enableLocation.value ? '开启' : '关闭');
}

// 新增：位置选择函数
async function onSelectLocation() {
  if (!enableLocation.value) return;

  try {
    const { state, values } = await Picker({
      modelValue: [selectedLocationIndex.value === -1 ? Math.round(locationPreset.length / 2) : selectedLocationIndex.value],
      columns: [
        locationPreset.map((v, i) => {
          return {
            text: v.name,
            value: i
          }
        })
      ],
      title: '选择签到地点',
    });

    if (state === "confirm") {
      selectedLocationIndex.value = values[0];
      console.log('选择位置:', locationPreset[values[0]].name);
    }
  } catch (error) {
    console.warn('位置选择失败:', error);
  }
}

// 新增：获取最新二维码数据的方法
function getLatestQrData() {
  return latestQrData.value;
}

// 新增：开始智能监控
function startSmartMonitoring() {
  if (isMonitoring.value) return;

  isMonitoring.value = true;
  if (!latestQrData.value) {
    form.tipMsg = '智能监控中，请扫描二维码...';
  }

  console.log('开始智能二维码监控');
}

// 新增：停止智能监控
function stopSmartMonitoring() {
  if (!isMonitoring.value) return;

  isMonitoring.value = false;
  form.tipMsg = '监控已停止';

  console.log('停止智能二维码监控');
}

// 暴露方法给父组件
defineExpose({
  getLatestQrData,
  startSmartMonitoring,
  stopSmartMonitoring,
  latestQrData
})

// 缩放变化处理
const onZoomChange = async () => {
  if (!videoTrack.value || !zoomSupported.value) return

  try {
    await videoTrack.value.applyConstraints({
      advanced: [{
        zoom: currentZoom.value
      }]
    })
  } catch (error) {
    console.warn('缩放调整失败:', error)
  }
}

// 检查并设置缩放功能
const checkZoomSupport = async (track) => {
  try {
    const capabilities = track.getCapabilities()
    if (capabilities.zoom) {
      zoomSupported.value = true
      zoomCapabilities.value = {
        min: capabilities.zoom.min || 1,
        max: capabilities.zoom.max || 3,
        step: capabilities.zoom.step || 0.1
      }
      currentZoom.value = capabilities.zoom.min || 1
      videoTrack.value = track
    }
  } catch (error) {
    console.warn('无法获取缩放功能:', error)
    zoomSupported.value = false
  }
}

const codeReader = new BrowserMultiFormatReader()
const openScan = () => {
  codeReader
    .getVideoInputDevices()
    .then(async (videoInputDevices) => {
      form.tipMsg = '正在调用摄像头...'
      let firstDeviceId = videoInputDevices[0].deviceId
      // 获取第一个摄像头设备的名称
      const videoInputDeviceslablestr = JSON.stringify(videoInputDevices[0].label)
      if (videoInputDevices.length > 1) {
        if (videoInputDeviceslablestr.indexOf('back') > -1) {
          firstDeviceId = videoInputDevices[0].deviceId
        } else {
          firstDeviceId = videoInputDevices[1].deviceId
        }
      }
      await decodeFromInputVideoFunc(firstDeviceId)
    })
    .catch((err) => {
      form.tipMsg = '请检查摄像头(权限)是否正常'
    })
}

const decodeFromInputVideoFunc = async (firstDeviceId) => {
  codeReader.reset() // 重置

  // 先获取媒体流以检查缩放支持
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: firstDeviceId,
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    })

    const videoTrackTemp = stream.getVideoTracks()[0]
    await checkZoomSupport(videoTrackTemp)

    // 设置视频源
    if (video.value) {
      video.value.srcObject = stream
    }
  } catch (error) {
    console.warn('获取媒体流失败:', error)
  }

  codeReader.decodeFromInputVideoDeviceContinuously(firstDeviceId, 'video', (result, err) => {
    form.tipMsg = '正在尝试识别...' // 提示信息
    if (result) {
      onScaned(result.getText())
    }
    if (err && !err) {
      form.tipMsg = '识别失败'
    }
  })
}
//销毁组件
onUnmounted(() => {
  if (videoTrack.value) {
    videoTrack.value.stop()
  }
  codeReader.reset();
  codeReader.stopContinuousDecode();
})

onMounted(() => {
  openScan() // 调用扫码方法

  // 如果启用了智能监控模式，自动开始监控
  if (props.enableSmartMonitoring) {
    startSmartMonitoring();
  }
})

// 监听智能监控模式的变化
watch(() => props.enableSmartMonitoring, (newVal) => {
  if (newVal) {
    startSmartMonitoring();
  } else {
    stopSmartMonitoring();
  }
})

</script>
<style scoped>
.bg {
  aspect-ratio: 1;
  width: 100%;
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

#video {
  object-fit: cover;
  width: 100%;
  height: 100%;
  background: #000;
}

.tip {
  position: absolute;
  bottom: 120px; /* 在位置控件上方 */
  left: 50%;
  transform: translateX(-50%);
  color: white;
  font-size: 16px;
  text-align: center;
  text-shadow: 2px 2px 8px rgba(0, 0, 0, 0.8);
  z-index: 114; /* 提高层级，确保在位置控件上方 */
  background: rgba(0, 0, 0, 0.5);
  padding: 8px 16px;
  border-radius: 20px;
  backdrop-filter: blur(10px);
}

/* 位置选择区域样式 */
.location-control {
  position: absolute;
  bottom: 16px; /* 在最底部 */
  left: 16px;
  right: 16px;
  z-index: 113;
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.8) 0%, rgba(0, 0, 0, 0.4) 70%, transparent 100%);
  padding: 16px;
  border-radius: 12px;
  backdrop-filter: blur(10px);
}

.location-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.location-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

/* 自定义开关样式 */
.custom-switch {
  width: 40px;
  height: 20px;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 10px;
  position: relative;
  transition: all 0.3s ease;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.custom-switch.active {
  background: var(--color-primary, #2196f3);
}

.switch-thumb {
  width: 16px;
  height: 16px;
  background: white;
  border-radius: 50%;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: all 0.3s ease;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.custom-switch.active .switch-thumb {
  transform: translateX(20px);
}

.location-label {
  color: white;
  font-size: 14px;
  font-weight: 500;
  text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.5);
}

.location-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(10px);
  border-radius: 20px;
  padding: 10px 16px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
  transition: all 0.2s ease;
}

.location-selector:hover {
  background: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
}

.location-selector:active {
  transform: translateY(0);
}

.location-text {
  flex: 1;
  color: white;
  font-size: 14px;
  font-weight: 500;
  text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.5);
}

.zoom-control {
  position: absolute;
  top: 20px; /* 恢复到顶部位置 */
  left: 20px;
  right: 20px;
  z-index: 112;
}

.zoom-slider-container {
  display: flex;
  align-items: center;
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(10px);
  border-radius: 25px;
  padding: 12px 20px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.zoom-label {
  color: white;
  font-size: 14px;
  font-weight: 500;
  margin-right: 12px;
  text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.5);
  white-space: nowrap;
}

.zoom-slider {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 6px;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 3px;
  outline: none;
  margin: 0 12px;
}

.zoom-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 20px;
  height: 20px;
  background: #ffffff;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  border: 2px solid rgba(255, 255, 255, 0.8);
  transition: all 0.2s ease;
}

.zoom-slider::-webkit-slider-thumb:hover {
  transform: scale(1.1);
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.4);
}

.zoom-slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  background: #ffffff;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  border: 2px solid rgba(255, 255, 255, 0.8);
  transition: all 0.2s ease;
}

.zoom-value {
  color: white;
  font-size: 14px;
  font-weight: 600;
  text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.5);
  white-space: nowrap;
  min-width: 35px;
  text-align: right;
}

/* 响应式设计 */
@media (max-width: 480px) {
  .zoom-control {
    top: 15px;
    left: 15px;
    right: 15px;
  }

  .zoom-slider-container {
    padding: 10px 16px;
  }

  .zoom-label, .zoom-value {
    font-size: 12px;
  }

  .tip {
    bottom: 15px;
    font-size: 14px;
    padding: 6px 12px;
  }
}

/* 暗黑模式适配 */
@media (prefers-color-scheme: dark) {
  .zoom-slider-container {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
}
</style>