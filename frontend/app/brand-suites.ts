export const brandSuites = [
  ['ripple','D · 心湖涟漪','连接向外展开，圆环缓缓消散 · 4.8秒'],
  ['constellation','E · 灵感星图','六颗微光依次点亮，连接保持稳定 · 5.4秒'],
  ['ribbon','F · 蓝色丝带','两道细线轻轻流动，像书写留下的轨迹 · 5秒'],
  ['beacon','G · 心有回响','四向短线渐显回应，中心标识安静呼吸 · 4秒'],
  ['portal','H · 双弧之门','外围双弧轻柔开合，迎接新的工作 · 5.2秒'],
  ['duet','I · 双星共鸣','两条细轨错向运行，中心Logo不旋转 · 6秒'],
] as const;
export type SuiteVariant = typeof brandSuites[number][0];
export const brandEffects:Partial<Record<string,string>>={
  ripple:'<g class="brand-ripple"><circle cx="60" cy="60" r="46"/><circle cx="60" cy="60" r="46"/></g>',
  constellation:'<g class="brand-stars"><path d="M20 34 60 9 101 35M19 87 60 111 101 85"/><circle cx="20" cy="34" r="2"/><circle cx="60" cy="9" r="2"/><circle cx="101" cy="35" r="2"/><circle cx="101" cy="85" r="2"/><circle cx="60" cy="111" r="2"/><circle cx="19" cy="87" r="2"/></g>',
  ribbon:'<g class="brand-ribbons"><path pathLength="100" d="M4 88Q30 101 60 96T116 99"/><path pathLength="100" d="M4 103Q38 91 60 105T116 108"/></g>',
  beacon:'<g class="brand-beacons"><path d="M60 8v9M60 103v9M7 60h10M103 60h10"/></g>',
  portal:'<g class="brand-portals"><path pathLength="100" d="M46 9a53 53 0 0 0 0 102"/><path pathLength="100" d="M74 9a53 53 0 0 1 0 102"/></g>',
  duet:'<g class="brand-duet"><circle cx="60" cy="60" r="51" pathLength="100"/><circle cx="60" cy="60" r="57" pathLength="100"/></g>',
};
