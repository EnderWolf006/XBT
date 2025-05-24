<template>
  <SignProgressDialog
    :key="dialogKey"
    :display="displayDialog"
    :data="signData"
    :qrCodeBoardRef="qrCodeBoardRef"
    @closeDialog="closeDialog"
  />
  <div style="overflow-y: auto;height: 100%;width: 100%;">
    <div style="height: fit-content;width: 100%;padding: 8px;box-sizing: border-box;">
      <div style="display: flex;flex-direction: row;align-items: center;">
        <h2 style="margin-right: auto;">签到详情</h2>
        <var-button type="primary" @click="router.back()">
          返回
        </var-button>
      </div>

      <var-paper elevation="4" class="paper">
        <var-cell :title="title" :description="description">
          <template #icon>
            <var-image width="42px" height="42px" fit="cover" radius="4" :src="proxyImage(currentClass.icon)"
              style="margin-right: 8px;" />
          </template>
        </var-cell>
        <var-divider margin="0"></var-divider>
        <component
          :is="signBoards[currentActive.signType]"
          :signCallBack="signCallBack"
          :enableSmartMonitoring="currentActive.signType === SignType.qrCode.id"
          ref="currentSignBoard"
        ></component>
      </var-paper>

      <div style="display: flex;flex-direction: row;align-items: center;">
        <h2>你将为以下同学代签:</h2>
        <var-loading size="small" v-show="isLoading" style="margin-left: 8px;" />
      </div>
      <var-paper elevation="2" class="paper">
        <template v-for="mate in classmates" :key="mate.uid">
          <var-cell :title="mate.name" :description="formatMobile(mate.mobile)" ripple
            @click="toggleClassmateSelection(mate.uid)">
            <template #icon>
              <var-image width="42px" height="42px" fit="cover" radius="4" :src="proxyImage(mate.avatar)"
                style="margin-right: 8px;" />
            </template>
            <template #extra>
              <var-checkbox v-model="mate.isSelected" @click.stop />
            </template>
          </var-cell>
          <var-divider margin="0" style="border-color: rgba(0,0,0,0.1);" hairline />
        </template>
      </var-paper>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref, computed, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useSelectedClassStore } from '@/stores/SelectedClassStore';
import { storeToRefs } from 'pinia';
import { SignType, proxyImage } from '@/utils/constants';
import { getChineseStringByDatetime } from '@/utils/datetime';
import { getSignStatus, getSignStatusIcon, getSignStatusColor, getSignSource } from '@/utils/sign';
import { Snackbar } from '@varlet/ui';
import api from '@/utils/api';
import dayjs from 'dayjs';
import CodeBoard from '@/components/signBoard/CodeBoard.vue';
import LocationBoard from '@/components/signBoard/LocationBoard.vue';
import GestureBoard from '@/components/signBoard/GestureBoard.vue';
import QrCodeBoard from '@/components/signBoard/QrCodeBoard.vue';
import NormalBoard from '@/components/signBoard/NormalBoard.vue';
import SignProgressDialog from '@/components/SignProgressDialog.vue';

const router = useRouter();
const route = useRoute();
const selectedClassStore = useSelectedClassStore();
const isLoading = ref(false);
const classmates = ref([]);
const displayDialog = ref(false);
const signData = reactive({});
const dialogKey = ref(Date.now());
// 新增：二维码组件引用和当前签到组件引用
const qrCodeBoardRef = ref(null);
const currentSignBoard = ref(null);

const signBoards = {
  [SignType.code.id]: CodeBoard,
  [SignType.location.id]: LocationBoard,
  [SignType.gesture.id]: GestureBoard,
  [SignType.qrCode.id]: QrCodeBoard,
  [SignType.normal.id]: NormalBoard
}

const currentClass = computed(() => {
  const classId = Number(route.query.classId);
  return selectedClassStore.getClassById(classId);
});

const currentActive = computed(() => {
  const classId = Number(route.query.classId);
  const activeId = Number(route.query.activeId);
  return selectedClassStore.getActiveById(classId, activeId);
});

const title = computed(() => {
  const signTypeName = SignType.fromId(currentActive.value.signType).name;
  return `${currentClass.value.name}【${signTypeName}】 `
})

const description = computed(() => {
  const startTime = dayjs(currentActive.value.startTime).format('YYYY-MM-DD HH:mm:ss');
  const status = getSignStatus(currentActive.value)
  const source = getSignSource(currentActive.value)
  return `${startTime} | ${status} | ${source}`;
})

function closeDialog(){
  displayDialog.value = false;
  dialogKey.value = Date.now() + Math.random();
}

function formatMobile(mobile) {
  const str = mobile.toString();
  return str.substring(0, 3) + '****' + str.substring(7);
}

function toggleClassmateSelection(uid) {
  const mate = classmates.value.find(m => m.uid === uid);
  if (mate) {
    mate.isSelected = !mate.isSelected;
  }
}

function signCallBack(data) {
  console.log('signCallBack 被调用，数据:', data, '签到类型:', currentActive.value.signType);

  if (displayDialog.value) {
    console.log('对话框已显示，忽略回调');
    return;
  }
  if (isLoading.value) {
    Snackbar.warning('加载同学列表中，请稍后');
    return;
  }

  // 更新二维码组件引用
  if (currentActive.value.signType === SignType.qrCode.id && currentSignBoard.value) {
    qrCodeBoardRef.value = currentSignBoard.value;
    console.log('已设置二维码组件引用，组件实例:', currentSignBoard.value);
  }

  signData.signType = currentActive.value.signType;
  signData.fixedParams = {
    courseId: currentClass.value.courseId,
    classId: currentClass.value.classId,
    activeId: currentActive.value.activeId,
    ifRefreshEwm: currentActive.value.ifRefreshEwm,
    uid: null, // 历史遗留
  }
  signData.specialParams = data;
  signData.classmates = classmates.value.filter(mate => mate.isSelected).map(mate => ({
    uid: mate.uid,
    name: mate.name,
    mobile: mate.mobile
  }));

  console.log('准备显示签到对话框，签到数据:', signData);
  displayDialog.value = true;
}

async function loadClassmates() {
  if (!currentClass.value) return;

  isLoading.value = true;
  try {
    const resp = await api.post('getClassmates', {
      courseId: currentClass.value.courseId,
      classId: currentClass.value.classId
    });
    if (!resp.data.suc) {
      Snackbar.warning(resp.data.msg);
      return;
    }
    classmates.value = resp.data.data.map(mate => ({
      ...mate,
      isSelected: true
    }));
  } catch (error) {
    Snackbar.error('获取同学列表失败');
  }
  isLoading.value = false;
}

onMounted(async () => {
  if (!route.query.classId || !route.query.activeId) {
    Snackbar.warning('无效的签到活动');
    router.back();
    return;
  }

  if (!currentClass.value || !currentActive.value) {
    Snackbar.warning('未找到对应的签到活动');
    router.back();
    return;
  }

  await loadClassmates();
});
</script>

<style scoped>
.paper {
  display: flex;
  flex-direction: column;
  user-select: none;
  -webkit-user-select: none;
}
</style>