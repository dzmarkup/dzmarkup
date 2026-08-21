// Shared DZ background theme list — edit here to add/remove combos.
// Both ey.dc.html and Download Gate.dc.html import this so they always match.
export const DZ_THEMES = [
  { name: 'Gingerbread Camo', style: 'camo', palette: ['#5c3317', '#8a4b28', '#c17f3e', '#f2c879', '#a4211d'] },
  { name: 'Gingerbread CadPat', style: 'cadpat', palette: ['#5c3317', '#8a4b28', '#c17f3e', '#f2c879', '#a4211d'] },
  { name: 'Blue Fantasy Rain', style: 'rain', palette: ['#0a1f44', '#1e5fae', '#3fa9f5', '#0d3b66'] },
  { name: 'Swedish CadPat', style: 'cadpat', palette: ['#3a4a52', '#5c6e6e', '#8a9a8a', '#c9c4a8', '#1f2b2e'] },
  { name: 'Knight Rider CadPat', style: 'cadpat', palette: ['#0a0a0a', '#1a1a1a', '#2a2a2a', '#ff1a1a', '#4a0000'] },
  { name: 'Arctic Camo', style: 'camo', palette: ['#0a1f2a', '#123a4a', '#1e5f7a', '#4ac1e0'] },
  { name: 'Blood Rain', style: 'rain', palette: ['#1a0505', '#3a0a0a', '#8a1010', '#1a1a1a'] },
  { name: 'Jungle CadPat', style: 'cadpat', palette: ['#1a2410', '#3a4a1e', '#6a8a3a', '#b0c060', '#0a1005'] },
];

// Deterministic pick based on the current 12-hour block, so both pages agree without syncing.
export function getAutoTheme() {
  const slot = Math.floor(Date.now() / (12 * 3600 * 1000));
  let h = slot; h = ((h << 5) - h + 2654435761) | 0;
  return DZ_THEMES[Math.abs(h) % DZ_THEMES.length];
}
