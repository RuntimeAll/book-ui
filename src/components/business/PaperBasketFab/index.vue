<script setup lang="ts">
/**
 * PaperBasketFab — 试卷篮全局浮动入口按钮（PRD-001 回归补丁）
 *
 * 背景：PRD-001 删掉旧绿色 PaperBasket(FAB+dialog 818 行)，功能迁入 /papers/basket
 *   三栏工作台。但删除后试卷篮失去唯一可见入口 → 用户加卷后看不见、进不去。
 *   本组件只承担「入口 + 角标」职责：点击直接跳工作台，不复活旧 dialog
 *   （查看篮内卷 / 移除 / 组卷分析 全部由 /papers/basket 工作台承接）。
 *
 * 设计镜像蓝色 QuestionBasket FAB，改色(绿) + 改图标 + 改 label + 点击跳路由。
 * 在 AppLayout 全局挂载一次，与蓝色试题栏 FAB 上下堆叠。
 */
import { useRouter } from 'vue-router'
import { Tickets } from '@element-plus/icons-vue'
import { usePaperBasket } from '@/composables/usePaperBasket'

const basket = usePaperBasket()
const router = useRouter()

function handleOpenWorkbench() {
  router.push('/papers/basket')
}
</script>

<template>
  <el-badge
    class="paper-basket-fab-badge"
    :value="basket.count.value > 99 ? '99+' : basket.count.value"
    :hidden="basket.count.value === 0"
    :offset="[-10, 8]"
    type="danger"
  >
    <div
      class="paper-basket-fab"
      :class="{ 'has-items': basket.count.value > 0 }"
      @click="handleOpenWorkbench"
    >
      <div class="fab-inner">
        <el-icon :size="20" color="#fff"><Tickets /></el-icon>
        <span class="fab-label">试卷篮</span>
      </div>
    </div>
  </el-badge>
</template>

<style scoped>
/* 锚点：fixed 定位在试题栏 FAB(bottom:40) 上方堆叠。
   两 FAB 各 64px 高 → 中心间距 = (152+32)-(72) = 不挤；试卷篮在上 bottom:152，
   与试题栏(40)的相邻间隙 = 152-(40+64) = 48px，中心间距 112px，明显拉开不重叠。 */
.paper-basket-fab-badge {
  position: fixed;
  bottom: 152px;
  right: 40px;
  z-index: 200;
  line-height: 0;
}

.paper-basket-fab {
  cursor: pointer;
}

.fab-inner {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: linear-gradient(135deg, #2bb673, #20a35f);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  box-shadow: 0 8px 24px rgba(43, 182, 115, 0.4);
  transition: all 0.25s ease;
}

.paper-basket-fab:hover .fab-inner {
  transform: translateY(-3px);
  box-shadow: 0 12px 32px rgba(43, 182, 115, 0.5);
}

.fab-label {
  font-size: 11px;
  color: #fff;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.paper-basket-fab.has-items .fab-inner {
  animation: paper-fab-pulse 2s infinite;
}

@keyframes paper-fab-pulse {
  0%, 100% { box-shadow: 0 8px 24px rgba(43, 182, 115, 0.4); }
  50% { box-shadow: 0 8px 30px rgba(43, 182, 115, 0.6); }
}
</style>
