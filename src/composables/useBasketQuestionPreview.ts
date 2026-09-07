import { reactive, ref, watch } from 'vue'
import type { BasketQuestion } from '@/api/questionBasket'
import { useUserStore } from '@/store/user'

/** 篮子详情已由服务端解析；空答案/解析是有效值，不重新读取原题。 */
export function useBasketQuestionPreview() {
  const explainState = reactive<
    Record<string, { open: boolean; img: string; text: string; loading: boolean }>
  >({})
  const previewVisible = ref(false)
  const previewItem = ref<BasketQuestion | null>(null)
  const previewDetail = reactive({
    answerImg: '',
    answerText: '',
    explainImg: '',
    explainText: '',
    loading: false,
  })
  const user = useUserStore()
  watch(
    () => user.accessToken,
    () => {
      previewVisible.value = false
      previewItem.value = null
      Object.keys(explainState).forEach((key) => delete explainState[key])
    },
  )

  function toggleExplain(item: BasketQuestion) {
    const previous = explainState[item.entryKey]
    explainState[item.entryKey] = {
      open: !previous?.open,
      img: item.explainImg ?? '',
      text: item.analyzeTextContent ?? item.explain ?? '',
      loading: false,
    }
  }

  function openPreview(item: BasketQuestion) {
    previewItem.value = item
    previewDetail.answerImg = item.answerImg ?? ''
    previewDetail.answerText = item.answerTextContent ?? item.answer ?? ''
    previewDetail.explainImg = item.explainImg ?? ''
    previewDetail.explainText = item.analyzeTextContent ?? item.explain ?? ''
    previewVisible.value = true
  }

  return { explainState, previewVisible, previewItem, previewDetail, toggleExplain, openPreview }
}
