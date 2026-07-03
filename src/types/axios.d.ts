// PRD-C-212 V0：拷自 codeplace-B/book-admin/src/types/axios.d.ts（plus-ui 约定）。
// manage 移植页的 api/system/* 返回类型是 AxiosPromise<VO[]>，运行时拦截器已解包为
// RuoYi 分页体 {code,msg,rows,total}，靠本增强让 res.rows/res.total 通过类型检查。
// ⚠️ 增强是全局加性的（业务轨 http/request 的响应类型也会多出这几个可选字段），
// 业务代码不要真用 res.rows —— 双轨分界见 src/README.md。
export {};
declare module 'axios' {
  interface AxiosResponse<T = any> {
    code: number;
    msg: string;
    rows: T;
    total: number;
  }
}
