/**
 * 新建文档模板。
 *
 * 模板正文以 HTML 片段保存：创建后由编辑器在空文档上执行一次 setContent，
 * 内容随协同事务写入 Y.Doc，服务端快照与其他在线成员自然收敛。
 */
export interface DocTemplate {
  id: string;
  label: string;
  /** 模板卡片与新建后封面使用的 emoji */
  icon: string;
  description: string;
  /** 新建时的默认标题；空白模板交给服务端兜底“未命名文档” */
  title?: string;
  /** 空串表示空白模板 */
  html: string;
}

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: 'blank',
    label: '空白文档',
    icon: '📄',
    description: '从零开始，自由排版',
    html: '',
  },
  {
    id: 'meeting',
    label: '会议纪要',
    icon: '🗒️',
    description: '议题、结论与待办一页收齐',
    title: '会议纪要',
    html: `
      <h1>会议信息</h1>
      <p>时间：　地点：　参与人：</p>
      <h1>议题</h1>
      <ul><li><p>议题一</p></li><li><p>议题二</p></li></ul>
      <h1>结论与决议</h1>
      <p>…</p>
      <h1>待办事项</h1>
      <ul data-type="taskList">
        <li data-type="taskItem" data-checked="false"><p>负责人 · 事项 · 截止时间</p></li>
      </ul>
    `,
  },
  {
    id: 'weekly',
    label: '周报',
    icon: '📅',
    description: '本周完成、下周计划与风险',
    title: '周报',
    html: `
      <h1>本周完成</h1>
      <ul><li><p>…</p></li></ul>
      <h1>数据与进展</h1>
      <p>…</p>
      <h1>下周计划</h1>
      <ul><li><p>…</p></li></ul>
      <h1>风险与求助</h1>
      <p>…</p>
    `,
  },
  {
    id: 'project',
    label: '项目计划',
    icon: '🎯',
    description: '目标、里程碑、分工与风险',
    title: '项目计划',
    html: `
      <h1>项目目标</h1>
      <p>…</p>
      <h1>关键里程碑</h1>
      <ul data-type="taskList">
        <li data-type="taskItem" data-checked="false"><p>里程碑一 · 时间 · 负责人</p></li>
        <li data-type="taskItem" data-checked="false"><p>里程碑二 · 时间 · 负责人</p></li>
      </ul>
      <h1>分工与协作</h1>
      <ul><li><p>…</p></li></ul>
      <h1>风险与应对</h1>
      <p>…</p>
    `,
  },
  {
    id: 'prd',
    label: '产品需求',
    icon: '💡',
    description: '背景、需求与验收标准',
    title: '产品需求',
    html: `
      <h1>背景与问题</h1>
      <p>…</p>
      <h1>目标用户</h1>
      <p>…</p>
      <h1>需求描述</h1>
      <ul><li><p>…</p></li></ul>
      <h1>验收标准</h1>
      <ul data-type="taskList">
        <li data-type="taskItem" data-checked="false"><p>…</p></li>
      </ul>
    `,
  },
];

/** 按 id 取模板；未知 id（例如旧链接）按空白文档处理。 */
export function findDocTemplate(id: string | null | undefined): DocTemplate | undefined {
  if (!id) return undefined;
  return DOC_TEMPLATES.find((template) => template.id === id);
}

/** 需要把模板正文写进文档的模板（排除空白模板）。 */
export function isContentTemplate(template: DocTemplate): boolean {
  return template.html.trim().length > 0;
}
