import {
  BLADE_ANGLES,
  DEFAULT_BLADE_WEAR_LIMIT,
  DEFAULT_WEAR_FACTORS,
  FALLBACK_WEAR_FACTOR,
  type Blade,
  type BladeChangeLog,
  type CutRecord,
} from './types'

/** 一把刀在某纸张上的折算系数：刀上的单独配置 → 内置默认 → 回退 1.0 */
export function wearFactorOf(blade: Blade, paper: string): number {
  const own = blade.wearFactors[paper]
  if (typeof own === 'number' && Number.isFinite(own) && own >= 0) return own
  return DEFAULT_WEAR_FACTORS[paper] ?? FALLBACK_WEAR_FACTOR
}

/** 新刀的系数表：只放内置纸张默认值，自定义纸张记账时再按回退系数补 */
export function defaultFactorTable(): Record<string, number> {
  return { ...DEFAULT_WEAR_FACTORS }
}

/**
 * 一次流水产生的磨损点：刀路长度（米）× 重复遍数 × 该纸张折算系数。
 * 长度与遍数是原始事实，系数随时可改 —— 累计磨损即由各流水实时重算。
 */
export function wearOfCut(cut: Pick<CutRecord, 'paper' | 'lengthMm' | 'passes'>, blade: Blade): number {
  const meters = (Math.max(0, cut.lengthMm) / 1000) * Math.max(1, Math.round(cut.passes))
  return meters * wearFactorOf(blade, cut.paper)
}

/** 一次流水折算的实际走刀里程（米）：长度 × 遍数 */
export function metersOfCut(cut: Pick<CutRecord, 'lengthMm' | 'passes'>): number {
  return (Math.max(0, cut.lengthMm) / 1000) * Math.max(1, Math.round(cut.passes))
}

export type BladeStats = {
  /** 当前累计磨损（磨损点，按当前系数重算） */
  wear: number
  /** 剩余寿命（磨损点），不为负 */
  remaining: number
  /** 已用寿命比例 0~1+（允许略超 1，退役刀可能超切一刀） */
  usedRatio: number
  /** 剩余寿命百分比（用于进度条，0~100） */
  remainingPct: number
  /** 一共切了多少米（长度 × 遍数累计） */
  totalMeters: number
  /** 切割流水条数 */
  cutCount: number
  /** 各纸张分别切了多少米（长度 × 遍数） */
  metersByPaper: Record<string, number>
  /** 最近一次切割时间 */
  lastCutAt: number | null
  /** 是否到了该换刀的上限 */
  wornOut: boolean
}

/** 汇总一把刀的全部流水：累计磨损 / 剩余寿命 / 总里程。改系数后重算即可，无需迁移历史。 */
export function bladeStats(blade: Blade, cuts: CutRecord[]): BladeStats {
  const own = cuts.filter((c) => c.bladeId === blade.id)
  let wear = 0
  let totalMeters = 0
  let lastCutAt: number | null = null
  const metersByPaper: Record<string, number> = {}
  for (const c of own) {
    wear += wearOfCut(c, blade)
    const m = metersOfCut(c)
    totalMeters += m
    metersByPaper[c.paper] = (metersByPaper[c.paper] ?? 0) + m
    if (c.at > (lastCutAt ?? 0)) lastCutAt = c.at
  }
  const limit = Math.max(1e-6, blade.wearLimit)
  const remaining = Math.max(0, limit - wear)
  return {
    wear,
    remaining,
    usedRatio: wear / limit,
    remainingPct: Math.max(0, Math.min(100, (remaining / limit) * 100)),
    totalMeters,
    cutCount: own.length,
    metersByPaper,
    lastCutAt,
    wornOut: wear >= limit,
  }
}

/** 最近为某把刀换过几次（changes 中以它为旧刀的记录数，时间倒序） */
export function changeCountOf(changes: BladeChangeLog[], bladeId: string): number {
  return changes.filter((c) => c.bladeId === bladeId).length
}

/** 最近换刀记录（全站，时间倒序） */
export function recentChanges(changes: BladeChangeLog[], limit = 5): BladeChangeLog[] {
  return changes.slice().sort((a, b) => b.at - a.at).slice(0, limit)
}

/** 可选刀具：在役且未磨损到顶（退役刀与到顶刀从可选列表挪出去） */
export function selectableBlades(blades: Blade[], cuts: CutRecord[]): Blade[] {
  return blades.filter((b) => b.status === 'active' && !bladeStats(b, cuts).wornOut)
}

/** 登记新刀的入参 */
export type NewBladeInput = {
  name: string
  angleDeg: number
  mountedAt?: number
  wearLimit?: number
  wearFactors?: Record<string, number>
  note?: string
}

/** 规范化刀刃角度到常用档位（30/45/60），自定义值原样保留 */
export function normalizeAngle(a: number): number {
  const n = Math.round(Number(a))
  if (!Number.isFinite(n)) return BLADE_ANGLES[1]
  return n
}

/** 换刀时构造旧刀的卸下快照（磨损点 / 总米数在换下瞬间固化进换刀记录） */
export function snapshotRetire(
  blade: Blade,
  cuts: CutRecord[],
  reason: 'limit' | 'manual',
): { wearAtRetire: number; totalMetersAtRetire: number; reason: 'limit' | 'manual' } {
  const s = bladeStats(blade, cuts)
  return { wearAtRetire: round2(s.wear), totalMetersAtRetire: round3(s.totalMeters), reason }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function clampWearLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BLADE_WEAR_LIMIT
  return Math.round(n * 10) / 10
}

/** 台账里的时间统一显示为 yyyy-MM-dd HH:mm */
export function fmtDateTime(ts: number | null | undefined): string {
  if (ts == null) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 磨损点/米数显示：保留到必要小数位，去掉多余的 0 */
export function fmtNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(digits).replace(/\.?0+$/, '')
}
