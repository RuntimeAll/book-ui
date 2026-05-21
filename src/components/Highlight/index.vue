<script lang="tsx">
/**
 * Highlight — 关键词高亮组件
 * 抽取自 vue-element-plus-admin 模板（kailong321200875）
 * 接口完全对齐模板真实版本：
 *   - tag: 包裹标签（默认 span）
 *   - keys: 需要高亮的关键词数组（每个 key 可点击，emit click）
 *   - color: 高亮颜色（默认用 el-color-primary CSS 变量）
 */
import { defineComponent, type PropType, computed, h, unref } from 'vue'

export default defineComponent({
  name: 'Highlight',
  props: {
    tag: {
      type: String,
      default: 'span'
    },
    keys: {
      type: Array as PropType<string[]>,
      default: () => []
    },
    color: {
      type: String,
      default: 'var(--el-color-primary)'
    }
  },
  emits: ['click'],
  setup(props, { emit, slots }) {
    const keyNodes = computed(() => {
      return props.keys.map((key) => {
        return h(
          'span',
          {
            onClick: () => {
              emit('click', key)
            },
            style: {
              color: props.color,
              cursor: 'pointer'
            }
          },
          key
        )
      })
    })

    const parseText = (text: string) => {
      props.keys.forEach((key, index) => {
        const regexp = new RegExp(key, 'g')
        text = text.replace(regexp, `{{${index}}}`)
      })
      return text.split(/{{|}}/)
    }

    const renderText = () => {
      if (!slots?.default) return null
      const node = slots?.default()[0].children

      if (!node) {
        return slots?.default()[0]
      }

      const textArray = parseText(node as string)
      const regexp = /^[0-9]*$/
      const nodes = textArray.map((t) => {
        if (regexp.test(t)) {
          return unref(keyNodes)[Number(t)] || t
        }
        return t
      })
      return h(props.tag, nodes)
    }

    return () => renderText()
  }
})
</script>
