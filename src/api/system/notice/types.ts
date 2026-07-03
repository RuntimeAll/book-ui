export interface NoticeVO {
  noticeId: number | string;
  noticeTitle: string;
  noticeType: string;
  noticeContent: string;
  status: string;
  createBy?: string | number;
  createByName?: string;
  createTime?: string;
  updateTime?: string;
  remark?: string;
}

export interface NoticeForm {
  noticeId: number | string | undefined;
  noticeTitle: string;
  noticeType: string;
  noticeContent: string;
  status: string;
  remark: string;
}

export interface NoticeQuery extends PageQuery {
  noticeTitle: string;
  noticeType: string;
  createByName?: string;
}
