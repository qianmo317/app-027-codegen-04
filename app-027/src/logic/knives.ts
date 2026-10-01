/**
 * 刀具台账（纯前端，localStorage 持久化）
 *
 * 磨损模型：
 *   一次切割的磨损量 = 实际刀路总长(m) × 重复遍数 × 该刀刃在该纸张上的折算系数
 *   - 多形状、多图层的活按整场总量（job.cutLengthMm 全场求和）记一笔，不拆分
 *   - 每笔记录保存纸张快照（paper 键 / 名称 / 遍数），改材料预设不会带乱旧账
 *   - 折算系数可按「刀 × 纸张」单独调；调完只重算该刀在该纸张上的历史账，
 *     其余纸张的累计量不动
 *   累计磨损 ≥ 磨损上限 → 状态「该换刀」，自动从可选刀列表中移出
 */
import { reactive, watch } from 'vue'
import { PAPER_KINDS } from './types'
import { uid } from './geometry'

/** 刀具状态：备用 / 在用 / 该换（到寿，已移出可选列表）/ 已退役（换刀卸下） */
export type KnifeStatus = 'spare' | 'in_use' | 'due' | 'retired'

export type Knife = {
  id: string
  /** 刀号 / 名称（如 3# 45° 刻刀） */
  name: string
  /** 刀刃角度（度） */
  edgeAngleDeg: number
  /** 登记（上机）时间 ms */
  mountedAt: number
  /** 磨损上限（折算米），累计磨损到此值即提示换刀 */
  wearLimit: number
  status: KnifeStatus
  /** 备注（品牌/装刀说明） */
  note: string
  /** 退役（卸下）时间 ms；换刀时写入 */
  retiredAt?: number
}

export type CutRecord = {
  id: string
  knifeId: string
  at: number
  /** 这一刀切的是哪个项目 / 活名（整场） */
  projectName: string
  /** 纸张键（PAPER_KINDS[].paper）；自定义纸张存原始键 */
  paper: string
  /** 记账时的纸张显示名快照 */
  paperLabel: string
  /** 整场实际刀路总长（mm，未乘遍数；多形状多图层已求和） */
  cutLengthMm: number
  /** 重复遍数（来自当时的材料预设快照） */
  passes: number
  /** 记账时生效的折算系数快照（仅展示用；重算以系数表为准） */
  factor: number
}

export type KnifeReplacement = {
  id: string
  at: number
  /** 卸下的旧刀 */
  oldKnifeId: string
  oldKnifeName: string
  /** 旧刀卸下时的累计磨损（折算米） */
  oldWear: number
  /** 旧刀一共实际切了多少米（不含遍数与系数，原始米数） */
  oldRawMeters: number
  /** 换上的刀（可能是备用刀，也可能是新登记的刀） */
  newKnifeId: string
  newKnifeName: string
  note?: string
}

export type KnifeLedgerState = {
  knives: Knife[]
  records: CutRecord[]
  replacements: KnifeReplacement[]
  /**
   * 折算系数表：knifeId → paper → 系数（磨损米 / 实际切割米·遍）。
   * 缺省回落到 DEFAULT_PAPER_FACTORS；同一把刀在不同纸张上可单独调。
   */
  factors: Record<string, Record<string, number>>
}

const LS_KEY = 'papercut-plotter-studio/knives-v1'

/** 各纸张的默认折算系数：单位「磨损分 / (实际切割米 × 遍数)」 */
export const DEFAULT_PAPER_FACTORS: Record<string, number> = {
  cardstock: 1.0,
  xuan: 0.7,
  sticker: 0.9,
  flock: 1.6,
  kraft: 1.1,
  'red-paper': 0.9,
}

export const DEFAULT_FACTOR_FALLBACK = 1.0

/** 新刀默认磨损上限（折算米）。常见桌面刻字机硬质合金刀约 500 折算米 */
export const DEFAULT_WEAR_LIMIT = 500

export function defaultFactorFor(paper: string): number {
  return DEFAULT_PAPER_FACTORS[paper] ?? DEFAULT_FACTOR_FALLBACK
}

export function paperLabelOf(paper: string): string {
  return PAPER_KINDS.find((p) => p.paper === paper)?.label ?? paper
}

// ---------------- 持久化 ----------------

function emptyState(): KnifeLedgerState {
  return { knives: [], records: [], replacements: [], factors: {} }
}

function normalize(raw: Partial<KnifeLedgerState> | null | undefined): KnifeLedgerState {
  const s = emptyState()
  if (!raw || typeof raw !== 'object') return s
  if (Array.isArray(raw.knives)) {
    s.knives = raw.knives.map((k) => ({
      ...k,
      note: k.note ?? '',
      edgeAngleDeg: Number(k.edgeAngleDeg) || 45,
      wearLimit: Number(k.wearLimit) > 0 ? Number(k.wearLimit) : DEFAULT_WEAR_LIMIT,
      mountedAt: Number(k.mountedAt) || Date.now(),
    }))
  }
  if (Array.isArray(raw.records)) {
    s.records = raw.records
      .filter((r) => r && r.knifeId && Number(r.cutLengthMm) >= 0)
      .map((r) => ({
        ...r,
        passes: Math.max(1, Number(r.passes) || 1),
        paperLabel: r.paperLabel || paperLabelOf(r.paper),
        factor: Number(r.factor) > 0 ? Number(r.factor) : defaultFactorFor(r.paper),
      }))
  }
  if (Array.isArray(raw.replacements)) s.replacements = raw.replacements.filter((r) => r && r.oldKnifeId && r.newKnifeId)
  if (raw.factors && typeof raw.factors === 'object') s.factors = raw.factors
  // 数据一致性：若没有在用刀但有备用刀，把最早的备用刀提为在用
  if (!s.knives.some((k) => k.status === 'in_use')) {
    const spare = s.knives.find((k) => k.status === 'spare')
    if (spare) spare.status = 'in_use'
  }
  return s
}

export function loadKnifeLedger(): KnifeLedgerState {
  try {
    if (typeof localStorage === 'undefined') return emptyState()
    const raw = localStorage.getItem(LS_KEY)
    return raw ? normalize(JSON.parse(raw)) : emptyState()
  } catch {
    return emptyState()
  }
}

export function saveKnifeLedger(s: KnifeLedgerState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    /* 存储不可用（隐私模式等）：仅内存态 */
  }
}

/** 全局响应式台账（与项目库的 store 模式一致，独立 localStorage key） */
export const ledger = reactive<KnifeLedgerState>(loadKnifeLedger())

let ledgerReady = false
watch(
  ledger,
  () => {
    if (ledgerReady) saveKnifeLedger(ledger)
  },
  { deep: true },
)
ledgerReady = true

/** 动作封装：改完即自动持久化 */
export const knifeActions = {
  register(input: NewKnifeInput): Knife {
    const k = registerKnife(ledger, input)
    saveKnifeLedger(ledger)
    return k
  },
  updateInfo(id: string, patch: Partial<Pick<Knife, 'name' | 'edgeAngleDeg' | 'wearLimit' | 'note'>>): void {
    updateKnifeInfo(ledger, id, patch)
    saveKnifeLedger(ledger)
  },
  setFactor(knifeId: string, paper: string, factor: number): void {
    setFactor(ledger, knifeId, paper, factor)
    saveKnifeLedger(ledger)
  },
  resetFactor(knifeId: string, paper: string): void {
    resetFactor(ledger, knifeId, paper)
    saveKnifeLedger(ledger)
  },
  logCut(input: CutInput): CutRecord | null {
    const r = logCut(ledger, input)
    if (r) saveKnifeLedger(ledger)
    return r
  },
  removeCut(recordId: string): void {
    removeCutRecord(ledger, recordId)
    saveKnifeLedger(ledger)
  },
  replace(oldId: string, newId: string, opts: { note?: string } = {}): KnifeReplacement | null {
    const r = replaceKnife(ledger, oldId, newId, opts)
    if (r) saveKnifeLedger(ledger)
    return r
  },
  setCurrent(id: string): void {
    setCurrent(ledger, id)
    saveKnifeLedger(ledger)
  },
  remove(id: string): void {
    deleteKnife(ledger, id)
    saveKnifeLedger(ledger)
  },
}

// ---------------- 纯计算（不修改状态，便于自检） ----------------

/** 该刀在某纸张上的当前折算系数 */
export function factorOf(s: KnifeLedgerState, knifeId: string, paper: string): number {
  const v = s.factors[knifeId]?.[paper]
  return typeof v === 'number' && v >= 0 ? v : defaultFactorFor(paper)
}

/** 单笔记录在当前系数下贡献的磨损量（折算米） */
export function recordWear(s: KnifeLedgerState, r: CutRecord): number {
  return (r.cutLengthMm / 1000) * r.passes * factorOf(s, r.knifeId, r.paper)
}

export type KnifeStats = {
  /** 累计磨损（折算米，按当前系数重算） */
  wear: number
  /** 一共实际切了多少米（原始刀路米数，不含遍数/系数） */
  rawMeters: number
  /** 计入遍数后实际刀尖走过的米数 */
  passMeters: number
  /** 切割笔数 */
  cuts: number
  /** 剩余寿命（折算米） */
  remaining: number
  /** 已用寿命比例 0~1+ */
  usedRatio: number
  /** 按纸张拆分的磨损（折算米） */
  wearByPaper: Record<string, number>
  /** 按纸张拆分的实际切割米数 */
  metersByPaper: Record<string, number>
}

export function statsOf(s: KnifeLedgerState, knifeId: string): KnifeStats {
  const knife = s.knives.find((k) => k.id === knifeId)
  const limit = knife?.wearLimit ?? DEFAULT_WEAR_LIMIT
  let wear = 0
  let rawMeters = 0
  let passMeters = 0
  let cuts = 0
  const wearByPaper: Record<string, number> = {}
  const metersByPaper: Record<string, number> = {}
  for (const r of s.records) {
    if (r.knifeId !== knifeId) continue
    const raw = r.cutLengthMm / 1000
    const w = recordWear(s, r)
    wear += w
    rawMeters += raw
    passMeters += raw * r.passes
    cuts += 1
    wearByPaper[r.paper] = (wearByPaper[r.paper] ?? 0) + w
    metersByPaper[r.paper] = (metersByPaper[r.paper] ?? 0) + raw
  }
  return {
    wear,
    rawMeters,
    passMeters,
    cuts,
    remaining: limit - wear,
    usedRatio: limit > 0 ? wear / limit : 0,
    wearByPaper,
    metersByPaper,
  }
}

/** 该刀是否已到寿 */
export function isWornOut(s: KnifeLedgerState, knife: Knife): boolean {
  return statsOf(s, knife.id).wear + 1e-9 >= knife.wearLimit
}

/** 可选刀列表：备用 + 在用（已到寿的 due / 已退役 retired 都不可选） */
export function selectableKnives(s: KnifeLedgerState): Knife[] {
  return s.knives.filter((k) => k.status === 'spare' || k.status === 'in_use')
}

export function currentKnife(s: KnifeLedgerState): Knife | null {
  return s.knives.find((k) => k.status === 'in_use') ?? null
}

/** 最近 n 次换刀（按时间倒序） */
export function recentReplacements(s: KnifeLedgerState, n = 3): KnifeReplacement[] {
  return s.replacements.slice().sort((a, b) => b.at - a.at).slice(0, n)
}

// ---------------- 变更操作（调用方负责 saveKnifeLedger） ----------------

export type NewKnifeInput = {
  name: string
  edgeAngleDeg: number
  wearLimit: number
  mountedAt?: number
  note?: string
  /** 登记即上机（默认 true）；若当前已有在用刀则只能登记为备用 */
  inUse?: boolean
}

/**
 * 登记一把刀。
 * - 没有任何在用刀时，默认直接上机（in_use）；
 * - 已有在用刀时登记为备用（spare），换刀时才能上机。
 */
export function registerKnife(s: KnifeLedgerState, input: NewKnifeInput): Knife {
  const hasInUse = s.knives.some((k) => k.status === 'in_use')
  const status: KnifeStatus = input.inUse === true && !hasInUse ? 'in_use' : 'spare'
  const k: Knife = {
    id: uid('knife'),
    name: input.name.trim() || '未命名刻刀',
    edgeAngleDeg: Number(input.edgeAngleDeg) > 0 ? Number(input.edgeAngleDeg) : 45,
    mountedAt: input.mountedAt ?? Date.now(),
    wearLimit: Number(input.wearLimit) > 0 ? Number(input.wearLimit) : DEFAULT_WEAR_LIMIT,
    status,
    note: input.note?.trim() ?? '',
  }
  s.knives.push(k)
  return k
}

export function updateKnifeInfo(s: KnifeLedgerState, id: string, patch: Partial<Pick<Knife, 'name' | 'edgeAngleDeg' | 'wearLimit' | 'note'>>): void {
  const k = s.knives.find((x) => x.id === id)
  if (!k) return
  if (patch.name !== undefined && patch.name.trim()) k.name = patch.name.trim()
  if (patch.edgeAngleDeg !== undefined && Number(patch.edgeAngleDeg) > 0) k.edgeAngleDeg = Number(patch.edgeAngleDeg)
  if (patch.wearLimit !== undefined && Number(patch.wearLimit) > 0) k.wearLimit = Number(patch.wearLimit)
  if (patch.note !== undefined) k.note = patch.note
  refreshDue(s, k)
}

/** 调整某把刀在某纸张上的折算系数；已累计的量按新系数重算（statsOf 始终按系数表现算） */
export function setFactor(s: KnifeLedgerState, knifeId: string, paper: string, factor: number): void {
  const f = Math.max(0, Number(factor) || 0)
  if (!s.factors[knifeId]) s.factors[knifeId] = {}
  s.factors[knifeId][paper] = f
  const k = s.knives.find((x) => x.id === knifeId)
  // 已退役的刀不再因为调系数改变状态；在用/备用刀重新判定是否该换
  if (k && k.status !== 'retired') refreshDue(s, k)
}

export function resetFactor(s: KnifeLedgerState, knifeId: string, paper: string): void {
  delete s.factors[knifeId]?.[paper]
  const k = s.knives.find((x) => x.id === knifeId)
  if (k && k.status !== 'retired') refreshDue(s, k)
}

/** 重算后若到寿，在用刀标为「该换」并从可选列表移出 */
function refreshDue(s: KnifeLedgerState, k: Knife): void {
  if (k.status === 'due' && !isWornOut(s, k)) {
    // 调低系数后可能重新回到寿命内：该换的刀恢复为在用
    k.status = 'in_use'
  } else if ((k.status === 'in_use' || k.status === 'spare') && isWornOut(s, k)) {
    k.status = 'due'
  }
}

export type CutInput = {
  knifeId: string
  projectName: string
  paper: string
  cutLengthMm: number
  passes: number
  at?: number
}

/**
 * 记一笔切割（整场一笔：多形状、多图层按总量）。
 * 返回创建的记录；若该刀不可用（该换/退役）返回 null。
 */
export function logCut(s: KnifeLedgerState, input: CutInput): CutRecord | null {
  const k = s.knives.find((x) => x.id === input.knifeId)
  if (!k || k.status === 'retired' || k.status === 'due') return null
  const len = Math.max(0, Number(input.cutLengthMm) || 0)
  const passes = Math.max(1, Math.round(Number(input.passes) || 1))
  const paper = input.paper || 'cardstock'
  const rec: CutRecord = {
    id: uid('cut'),
    knifeId: k.id,
    at: input.at ?? Date.now(),
    projectName: input.projectName.trim() || '未命名活',
    paper,
    paperLabel: paperLabelOf(paper),
    cutLengthMm: Math.round(len * 1000) / 1000,
    passes,
    factor: factorOf(s, k.id, paper),
  }
  s.records.push(rec)
  refreshDue(s, k)
  return rec
}

/** 删掉一笔切割账（记错时撤销），磨损自动回落 */
export function removeCutRecord(s: KnifeLedgerState, recordId: string): void {
  const i = s.records.findIndex((r) => r.id === recordId)
  if (i < 0) return
  const knifeId = s.records[i].knifeId
  s.records.splice(i, 1)
  const k = s.knives.find((x) => x.id === knifeId)
  if (k && k.status !== 'retired') refreshDue(s, k)
}

/**
 * 换刀：旧刀卸下退役，换上 newKnifeId（备用刀或新登记的刀），并记一笔换刀账。
 * oldSnapshot 的磨损/米数在退役瞬间冻结写入换刀记录。
 */
export function replaceKnife(
  s: KnifeLedgerState,
  oldKnifeId: string,
  newKnifeId: string,
  opts: { at?: number; note?: string } = {},
): KnifeReplacement | null {
  const oldK = s.knives.find((k) => k.id === oldKnifeId)
  const newK = s.knives.find((k) => k.id === newKnifeId)
  if (!oldK || !newK || oldK.id === newK.id) return null
  const st = statsOf(s, oldK.id)
  const at = opts.at ?? Date.now()
  oldK.status = 'retired'
  oldK.retiredAt = at
  newK.status = 'in_use'
  // 其余备用刀保持 spare
  const rep: KnifeReplacement = {
    id: uid('rep'),
    at,
    oldKnifeId: oldK.id,
    oldKnifeName: oldK.name,
    oldWear: st.wear,
    oldRawMeters: st.rawMeters,
    newKnifeId: newK.id,
    newKnifeName: newK.name,
    note: opts.note?.trim() || undefined,
  }
  s.replacements.push(rep)
  return rep
}

/** 手动把备用刀设为在用（不经过换刀流程的场景，如首次装刀调整） */
export function setCurrent(s: KnifeLedgerState, knifeId: string): void {
  const target = s.knives.find((k) => k.id === knifeId)
  if (!target || target.status === 'retired') return
  for (const k of s.knives) if (k.status === 'in_use') k.status = 'spare'
  target.status = target.status === 'due' ? 'due' : 'in_use'
}

/** 删除一把刀（同时清理它的切割账；换刀记录保留历史名字） */
export function deleteKnife(s: KnifeLedgerState, knifeId: string): void {
  const i = s.knives.findIndex((k) => k.id === knifeId)
  if (i < 0) return
  s.knives.splice(i, 1)
  s.records = s.records.filter((r) => r.knifeId !== knifeId)
  delete s.factors[knifeId]
  if (!s.knives.some((k) => k.status === 'in_use')) {
    const spare = s.knives.find((k) => k.status === 'spare')
    if (spare) spare.status = 'in_use'
  }
}
