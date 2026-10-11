import {themePresets} from '../../src/shared/theme-presets';
export const designThemes=themePresets;
export function themeGallery(){
  return '<div class="theme-gallery" data-carousel="themes" aria-label="主题套件">'+designThemes.map(theme=>{
    const p=theme.light;
    return '<article class="theme-study" style="--study-canvas:#ffffff;--study-surface:#f5f7fa;--study-ink:#17212b;--study-sidebar:'+p.sidebar+';--study-accent:'+p.accent+'"><div class="theme-study-canvas"><small>灵犀工作坊</small><div class="theme-study-layer"><span>本周计划</span><strong>08</strong><div><i></i><i></i><i></i></div></div><div class="theme-study-note">顶栏、侧栏与强调色预设</div></div><h3>'+theme.name+'</h3><p>'+theme.about+'</p><button type="button" class="onboarding-action secondary" data-design-preset="'+theme.id+'" aria-pressed="false">应用主题</button></article>';
  }).join('')+'</div>';
}
