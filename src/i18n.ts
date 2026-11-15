// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Runtime bilingual dictionary (default strictly 'en' for NASA Space Apps
// evaluation; users can switch to 'tr' at any time from the top command bar).

import type { Traverser } from './data';

export type Lang = 'en' | 'tr';

let currentLang: Lang = 'en';
const listeners = new Set<(lang: Lang) => void>();

export function getLang(): Lang {
  return currentLang;
}

export function setLang(next: Lang): void {
  if (next !== 'en' && next !== 'tr') return;
  if (currentLang === next) return;
  currentLang = next;
  document.documentElement.lang = next;
  for (const fn of listeners) fn(next);
}

export function onLangChange(listener: (lang: Lang) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function ui(en: string, tr: string): string {
  return currentLang === 'tr' ? tr : en;
}

const TRAVERSER_TR: Record<string, { name: string; short: string; note: string }> = {
  yuruyen_insan: {
    name: 'Yürüyen astronot (giysili)',
    short: 'Yürüyen Astronot',
    note: 'Giysili yaya EVA; yönlü çıkış/iniş eğim hızları ve 20 m termal atalet zemin etkisini kullanır.',
  },
  roverli_insan: {
    name: 'İnsanlı rover',
    short: 'İnsanlı Rover',
    note: 'Menzil, rover arızalanırsa üsse yürüyerek dönüş (walk-back) hayatta kalma kuralıyla sınırlıdır.',
  },
  rover: {
    name: 'İnsansız rover',
    short: 'İnsansız Rover',
    note: 'Robotik keşif senaryosu (insan yaşam destek süresi yok; yüksek eğim ve uzun mesafe).',
  },
  suited_astronaut: {
    name: 'Giysili astronot',
    short: 'Astronot',
    note: 'Giysili yaya keşif.',
  },
};

export function traverserName(t: Traverser): string {
  if (currentLang === 'tr') {
    const tr = TRAVERSER_TR[t.id];
    if (tr) return tr.name;
  }
  return t.ad_en;
}

export function traverserShortName(t: Traverser): string {
  if (currentLang === 'tr') {
    const tr = TRAVERSER_TR[t.id];
    if (tr) return tr.short;
  }
  if (t.id === 'yuruyen_insan') return 'Walking astronaut';
  return t.ad_en;
}

export function traverserNote(t: Traverser): string {
  if (currentLang === 'tr') {
    const tr = TRAVERSER_TR[t.id];
    if (tr) return tr.note;
  }
  return t.aciklama_en ?? '';
}

export function formatStintStopLabel(traverserId: string, nextStint: number): string {
  const isEva = traverserId === 'yuruyen_insan' || traverserId === 'suited_astronaut';
  if (currentLang === 'tr') {
    return isEva ? `DUR · ${nextStint}. EVA` : `DUR · ${nextStint}. Sol`;
  }
  return isEva ? `STOP · EVA ${nextStint}` : `STOP · Sol ${nextStint}`;
}

export function stintUnitLabel(traverserId: string, count: number): string {
  const isEva = traverserId === 'yuruyen_insan' || traverserId === 'suited_astronaut';
  if (currentLang === 'tr') {
    return isEva ? `${count} EVA` : `${count} Sol`;
  }
  return isEva ? `${count} ${count === 1 ? 'EVA' : 'EVAs'}` : `${count} ${count === 1 ? 'sol' : 'sols'}`;
}

export function translateDecisionReason(reason: string): string {
  if (currentLang !== 'tr') return reason;
  if (reason === 'rock and thermal inertia data not available (assumed)') {
    return 'kaya ve termal atalet verisi yok (varsayıldı)';
  }
  if (reason === 'sub-grid rock data not resolved at grid scale (assumed)') {
    return 'ızgara altı kaya verisi bu ölçekte çözülmedi (varsayıldı)';
  }
  if (reason === 'thermal inertia not resolved at grid scale (assumed)') {
    return 'termal atalet bu ızgara ölçeğinde çözülmedi (varsayıldı)';
  }
  if (reason === 'walk-back survival time limit exceeded (broken: time)' || reason === 'walk-back survival limit exceeded (broken: time)') {
    return 'walk-back hayatta kalma süre sınırı aşıldı (bozulan: süre)';
  }
  if (reason === 'max mission duration exceeded (broken: time)' || reason === 'max excursion duration exceeded (broken: time)') {
    return 'azami görev süresi aşıldı (bozulan: süre)';
  }
  if (reason === 'usable battery exhausted before reserve (broken: energy)') {
    return 'kullanılabilir batarya rezerv sınırının altına düştü (bozulan: enerji)';
  }
  if (reason === 'marginal (class 1) landing site' || reason === 'marginal landing zone') {
    return 'sınırda (sınıf 1) iniş alanı';
  }
  if (reason === 'route crosses unmapped no-data terrain' || reason === 'crosses unmapped (no-data) terrain') {
    return 'haritasız (veri yok) araziden geçiyor';
  }
  if (reason === 'route crosses caution hazard terrain' || reason === 'crosses caution terrain') {
    return 'dikkat gerektiren (caution) araziden geçiyor';
  }
  if (reason === 'all evaluated corridor checks passed' || reason === 'all operational constraints met') {
    return 'değerlendirilen tüm koridor kontrolleri geçti';
  }
  const radialV2 = reason.match(/^radial standoff > (.+?) km from base \(broken: distance\)$/);
  if (radialV2) {
    return `> ${radialV2[1]} km kuş uçuşu mesafe tavanı aşıldı (bozulan: mesafe)`;
  }
  const totalDistMatch = reason.match(/^total traverser range > (.+?) km exceeded \(broken: distance\)$/);
  if (totalDistMatch) {
    return `toplam gezgin menzili (> ${totalDistMatch[1]} km) aşıldı (bozulan: mesafe)`;
  }
  const radialMatch = reason.match(/^> (.+?) radial standoff limit exceeded \(broken: distance\)$/);
  if (radialMatch) {
    return `> ${radialMatch[1]} kuş uçuşu mesafe tavanı aşıldı (bozulan: mesafe)`;
  }
  const marginV2 = reason.match(/^safety time margin < 10% \((\d+)% remaining\)$/);
  if (marginV2) {
    return `en küçük güvenlik payı < %10 (%${marginV2[1]} kaldı)`;
  }
  const marginMatch = reason.match(/^minimum safety margin < 10% \((\d+)%\)$/);
  if (marginMatch) {
    return `en küçük güvenlik payı < %10 (%${marginMatch[1]})`;
  }
  return reason;
}
