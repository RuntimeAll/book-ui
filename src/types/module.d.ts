// PRD-C-212 V0：manage 移植页（plus-ui）globalProperties 类型声明。
// 拷自 codeplace-B/book-admin/src/types/module.d.ts，按 C 线 src/plugins/index.ts 实际挂载适配：
// C 线未移植 i18n，去掉 $t / @/lang；其余与 installPlugin 一一对应。
import modal from '@/plugins/modal';
import tab from '@/plugins/tab';
import download from '@/plugins/download';
import auth from '@/plugins/auth';
import cache from '@/plugins/cache';
import animate from '@/animate';
import { useDict } from '@/utils/dict';
import { handleTree, addDateRange, selectDictLabel, selectDictLabels, parseTime } from '@/utils/ruoyi';
import { getConfigKey, updateConfigByKey } from '@/api/system/config';
import { download as rd } from '@/utils/request';

export {};

declare module 'vue' {
  interface ComponentCustomProperties {
    // 全局方法声明（manage 移植页专用，业务页勿用 —— 双轨分界见 src/README.md）
    $modal: typeof modal;
    $tab: typeof tab;
    $download: typeof download;
    $auth: typeof auth;
    $cache: typeof cache;
    animate: typeof animate;

    useDict: typeof useDict;
    addDateRange: typeof addDateRange;
    download: typeof rd;
    handleTree: typeof handleTree;
    getConfigKey: typeof getConfigKey;
    updateConfigByKey: typeof updateConfigByKey;
    selectDictLabel: typeof selectDictLabel;
    selectDictLabels: typeof selectDictLabels;
    parseTime: typeof parseTime;
  }
}
