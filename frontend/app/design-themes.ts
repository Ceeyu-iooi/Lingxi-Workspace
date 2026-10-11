export const designThemes = [
  {id:'mist',name:'雾蓝工作室',about:'清晰、理性。适合用量、账单与密集工作信息。',canvas:'#ffffff',surface:'#f5f8fa',ink:'#17212b',accent:'#3976f6'},
  {id:'linen',name:'亚麻书房',about:'温润、松弛。适合笔记、总结与长文阅读。',canvas:'#faf8f4',surface:'#fffdf9',ink:'#40392f',accent:'#956445'},
  {id:'jade',name:'青玉庭院',about:'安静、鲜活。适合项目规划与日常安排。',canvas:'#f4f8f5',surface:'#fcfffd',ink:'#243a34',accent:'#397666'},
  {id:'nocturne',name:'夜航墨色',about:'沉静、专注。适合夜间阅读与趋势观察。',canvas:'#101820',surface:'#1b2731',ink:'#eef3f6',accent:'#9cc5fa'},
] as const;
export function themeGallery(){return `<div class="preview-grid four theme-gallery">${designThemes.map(theme=>`<article class="theme-study" style="--study-canvas:${theme.canvas};--study-surface:${theme.surface};--study-ink:${theme.ink};--study-accent:${theme.accent}"><div class="theme-study-canvas"><small>灵犀工作坊</small><div class="theme-study-layer"><span>本周计划</span><strong>08</strong><div><i></i><i></i><i></i></div></div><div class="theme-study-note">让每一项工作有自己的位置</div></div><h3>${theme.name}</h3><p>${theme.about}</p><button type="button" class="onboarding-action secondary" data-design-preset="${theme.id}" aria-pressed="false">应用至预览</button></article>`).join('')}</div>`;}
