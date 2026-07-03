import type * as ep from 'element-plus';
declare global {
  // RuoYi 字典 listClass 域（非 element-plus 官方 TagType）：后台字典管理页 listClass 下拉除
  // primary/success/info/warning/danger 外还允许「默认」= 'default' 及历史空值 ''，DictTag 组件按
  // 此判空/判默认渲染纯文本、非空值渲染 el-tag。
  declare type ElTagType = 'default' | 'primary' | 'success' | 'info' | 'warning' | 'danger' | '';
  declare type ElFormInstance = ep.FormInstance;
  declare type ElTableInstance = ep.TableInstance;
  declare type ElUploadInstance = ep.UploadInstance;
  declare type ElScrollbarInstance = ep.ScrollbarInstance;
  declare type ElInputInstance = ep.InputInstance;
  declare type ElInputNumberInstance = ep.InputNumberInstance;
  declare type ElRadioInstance = ep.RadioInstance;
  declare type ElRadioGroupInstance = ep.RadioGroupInstance;
  declare type ElRadioButtonInstance = ep.RadioButtonInstance;
  declare type ElCheckboxInstance = ep.CheckboxInstance;
  declare type ElSwitchInstance = ep.SwitchInstance;
  declare type ElCascaderInstance = ep.CascaderInstance;
  declare type ElColorPickerInstance = ep.ColorPickerInstance;
  declare type ElRateInstance = ep.RateInstance;
  declare type ElSliderInstance = ep.SliderInstance;

  declare type ElTreeInstance = InstanceType<typeof ep.ElTree>;
  declare type ElTreeSelectInstance = InstanceType<typeof ep.ElTreeSelect>;
  declare type ElSelectInstance = InstanceType<typeof ep.ElSelect>;
  declare type ElCardInstance = InstanceType<typeof ep.ElCard>;
  declare type ElDialogInstance = InstanceType<typeof ep.ElDialog>;
  declare type ElCheckboxGroupInstance = InstanceType<typeof ep.ElCheckboxGroup>;
  declare type ElDatePickerInstance = InstanceType<typeof ep.ElDatePicker>;
  declare type ElTimePickerInstance = InstanceType<typeof ep.ElTimePicker>;
  declare type ElTimeSelectInstance = InstanceType<typeof ep.ElTimeSelect>;

  declare type TransferKey = ep.TransferKey;
  declare type CheckboxValueType = ep.CheckboxValueType;
  declare type ElFormRules = ep.FormRules;
  declare type DateModelType = ep.DateModelType;
  declare type UploadFile = ep.UploadFile;
}
