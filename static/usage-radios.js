/* Real JellyRadio controls adapt the original independent chart state/actions. */
(() => {
  const states=new WeakMap();
  function group(host,title,choices,change){
    const root=document.createElement('div');root.className='radio-inputs';host.append(root);let value=choices[0][0];
    const render=()=>window.WorkbenchUI.radio(root,{label:title,items:choices,value,onChange:change});render();
    return {root,set(v,costLabel){value=v;if(costLabel)choices.forEach(c=>{if(c[0]==='cost')c[1]=costLabel;});render();}};
  }
  function mount(root){
    if(states.has(root))return;const heat=root.querySelector('.usage-heat-modes'),charts=root.querySelector('.usage-chart-tools');
    const old=[...root.querySelectorAll('[data-heat-mode],[data-chart-mode],button[data-metric],.usage-pie-toggle')];old.forEach(button=>button.classList.add('usage-radio-action'));
    const s={};
    s.metricHeat=group(heat,'活动统计量',[['token','Token'],['cost','费用']],v=>{const b=heat.querySelector('[data-metric=heat]');if((b.getAttribute('aria-pressed')==='true')!==(v==='cost'))b.click();});
    s.heat=group(heat,'活动时间统计',[['day','每日'],['week','每周'],['total','累计']],v=>root.querySelector('[data-heat-mode='+v+']').click());
    s.chart=group(charts,'趋势图类型',[['line','曲线'],['bar','柱状']],v=>{const b=root.querySelector('[data-chart-mode]');if(b.dataset.chartMode!==v)b.click();});
    s.metricChart=group(charts,'图表统计量',[['token','Token'],['cost','费用']],v=>{const b=charts.querySelector('[data-metric=charts]');if((b.getAttribute('aria-pressed')==='true')!==(v==='cost'))b.click();});
    states.set(root,s);
  }
  function sync(root){
    const s=states.get(root);if(!s)return;
    s.heat.set(root.dataset.heatViewMode||'day');s.chart.set(root.dataset.chartViewMode||'line');
    for(const [name,key] of [['metricHeat','heat'],['metricChart','charts']]){const button=root.querySelector('button[data-metric='+key+']');s[name].root.hidden=button.hidden;s[name].set(button.getAttribute('aria-pressed')==='true'?'cost':'token',['codex','zcode','dsh'].includes(root.dataset.usageScope)?'API 参考等价值':'费用');}
  }
  window.usageRadios={mount,sync};
})();
