import { reactive, watch } from 'vue'
import {
  DEFAULT_BLADE_WEAR_LIMIT,
  DEFAULT_CUT_SETTINGS,
  DEFAULT_EXPORT_CFG,
  DEFAULT_SHEET,
  type BatchCfg,
  type Blade,
  type BladeChangeLog,
  type BladeLedger,
  type ContourWarning,
  type CutRecord,
  type CutSettings,
  type ExportCfg,
  type MaterialPreset,
  type Project,
  type RetireReason,
  type Shape,
  type Sheet,
} from './types'
import { computeShape, shapeSignature, type ComputedShape } from './pipeline'
import { buildBatchShape, buildJob, type Job } from './job'
import { uid } from './geometry'
import { importSvgText, type ImportResult } from './importer'
import { defaultMaterials } from '@/data/materials'
import { bladeStats, clampWearLimit, defaultFactorTable, normalizeAngle, snapshotRetire } from './blade'

const LS_KEY = 'papercut-plotter-studio/v1'

type Persisted = {
  version: number
  projects: Project[]
  materials: MaterialPreset[]
  ledger?: BladeLedger
}

type StoreState = {
  projects: Project[]
  materials: MaterialPreset[]
  ledger: BladeLedger
  ready: boolean
  lastError: string | null
}

function emptyLedger(): BladeLedger {
  return { blades: [], cuts: [], changes: [], mountedBladeId: null }
}

export const state = reactive<StoreState>({
  projects: [],
  materials: [],
  ledger: emptyLedger(),
  ready: false,
  lastError: null,
})

/** 派生计算结果缓存（按几何签名失效，不持久化） */
const computedCache = reactive<Record<string, ComputedShape>>({})
const batchCache = new Map<string, ComputedShape>()

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

export function loadState(): void {
  state.materials = defaultMaterials()
  if (!canUseStorage()) {
    state.ready = true
    return
  }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Persisted
      if (parsed && Array.isArray(parsed.projects)) {
        state.projects = parsed.projects.map(normalizeProject)
      }
      if (parsed && Array.isArray(parsed.materials) && parsed.materials.length > 0) {
        state.materials = parsed.materials.map((m) => ({ ...m, backing: m.backing ?? '常规垫板' }))
      }
      state.ledger = normalizeLedger(parsed.ledger)
    }
  } catch (e) {
    state.lastError = `本地数据读取失败：${(e as Error).message}`
  }
  state.ready = true
  recomputeAll()
}

export function saveNow(): void {
  if (!canUseStorage()) return
  try {
    const data: Persisted = {
      version: 1,
      projects: state.projects,
      materials: state.materials,
      ledger: state.ledger,
    }
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch (e) {
    state.lastError = `本地保存失败：${(e as Error).message}`
  }
}

let saveTimer: number | null = null
export function scheduleSave(): void {
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 250)
}

function normalizeProject(p: Project): Project {
  return {
    ...p,
    settings: { ...DEFAULT_CUT_SETTINGS, ...(p.settings ?? {}) },
    export: { ...DEFAULT_EXPORT_CFG, ...(p.export ?? {}) },
    sheet: p.sheet ?? { ...DEFAULT_SHEET },
    shapes: (p.shapes ?? []).map((s) => ({
      ...s,
      contours: (s.contours ?? []).map((c) => ({ ...c, holes: c.holes ?? [], bridges: c.bridges ?? [], warnings: c.warnings ?? [] })),
    })),
    layerNames: p.layerNames ?? ['图层 1'],
  }
}

/** 老版本无台账时给出空账；字段缺失逐项补齐，系数表不强制回填（折算时按默认值回退） */
function normalizeLedger(l: BladeLedger | undefined): BladeLedger {
  if (!l || typeof l !== 'object') return emptyLedger()
  const blades: Blade[] = (Array.isArray(l.blades) ? l.blades : []).map((b) => ({
    ...b,
    angleDeg: normalizeAngle(b.angleDeg),
    wearLimit: clampWearLimit(b.wearLimit),
    wearFactors: { ...(b.wearFactors ?? {}) },
    status: b.status === 'retired' ? 'retired' : 'active',
    retireReason: b.retireReason === 'limit' || b.retireReason === 'manual' ? b.retireReason : undefined,
  }))
  const ids = new Set(blades.map((b) => b.id))
  const cuts: CutRecord[] = (Array.isArray(l.cuts) ? l.cuts : [])
    .filter((c) => ids.has(c.bladeId))
    .map((c) => ({
      ...c,
      paperLabel: c.paperLabel ?? c.paper,
      lengthMm: Math.max(0, Number(c.lengthMm) || 0),
      passes: Math.max(1, Math.round(Number(c.passes) || 1)),
      force: Number(c.force) || 0,
      speedMmS: Number(c.speedMmS) || 0,
    }))
  const changes: BladeChangeLog[] = (Array.isArray(l.changes) ? l.changes : []).map((c) => ({ ...c }))
  const mountedBladeId = typeof l.mountedBladeId === 'string' && ids.has(l.mountedBladeId) ? l.mountedBladeId : null
  return { blades, cuts, changes, mountedBladeId }
}

export function materialOf(p: Project): MaterialPreset | null {
  return state.materials.find((m) => m.id === p.materialId) ?? state.materials[0] ?? null
}

/** 重算派生数据（清理结果 → 连刀点 → 刀补 → 包含树 → 切割顺序） */
export function recomputeProject(p: Project, force = false): void {
  const material = materialOf(p)
  for (const shape of p.shapes) {
    const sig = shapeSignature(shape, p.settings, material)
    const cached = computedCache[shape.id]
    if (!force && cached && cached.signature === sig) continue
    const res = computeShape(shape, p.settings, material)
    applyComputed(shape, res)
    computedCache[shape.id] = res
  }
}

export function recomputeAll(force = false): void {
  for (const p of state.projects) recomputeProject(p, force)
}

/** 回写清理/派生警告（连刀点中只有手工放置的保存在数据模型里） */
function applyComputed(shape: Shape, res: ComputedShape): void {
  for (const c of shape.contours) {
    const base = c.warnings.filter(
      (w) => w === 'not_closed' || w === 'self_intersect' || w === 'duplicate' || w === 'too_short',
    ) as ContourWarning[]
    const extra = res.warningUpdates.get(c.id) ?? []
    c.warnings = [...base, ...extra.filter((w) => !base.includes(w))]
  }
}

export function computedOf(shapeId: string): ComputedShape | null {
  return computedCache[shapeId] ?? null
}

/** 排版任务：批量排版开启时只排所选纹样，否则排全部形状 */
export function jobOf(p: Project): { job: Job; shape: Shape | null; isBatch: boolean; computed: Map<string, ComputedShape> } {
  const material = materialOf(p)
  const start = { x: 0, y: 0 }
  const batch = p.batch
  if (batch && batch.enabled) {
    const src = p.shapes.find((s) => s.id === p.batchShapeId) ?? p.shapes[0]
    if (src) {
      const tiled = buildBatchShape(src, batch)
      const sig = `batch|${shapeSignature(src, p.settings, material)}|${batch.rows}|${batch.cols}|${batch.gapXMm}|${batch.gapYMm}|${batch.mode}`
      let comp = batchCache.get(sig)
      if (!comp) {
        comp = computeShape(tiled, p.settings, material, start)
        batchCache.set(sig, comp)
        if (batchCache.size > 24) {
          const firstKey = batchCache.keys().next().value
          if (firstKey !== undefined) batchCache.delete(firstKey)
        }
      }
      const map = new Map<string, ComputedShape>([[tiled.id, comp]])
      const job = buildJob([tiled], map, layerOrderOf(p), { sharedEdge: batch.sharedEdge, start })
      return { job, shape: tiled, isBatch: true, computed: map }
    }
  }
  recomputeProject(p)
  const map = new Map<string, ComputedShape>()
  for (const s of p.shapes) {
    const c = computedCache[s.id]
    if (c) map.set(s.id, c)
  }
  const job = buildJob(p.shapes, map, layerOrderOf(p), { sharedEdge: false, start })
  return { job, shape: null, isBatch: false, computed: map }
}

export function layerOrderOf(p: Project): number[] {
  const set = new Set(p.shapes.map((s) => s.layer))
  return Array.from(set).sort((a, b) => a - b)
}

// ---------------- 项目与形状操作 ----------------

function newProject(name: string, shapes: Shape[]): Project {
  const now = Date.now()
  return {
    id: uid('p'),
    name,
    createdAt: now,
    updatedAt: now,
    shapes,
    settings: { ...DEFAULT_CUT_SETTINGS },
    export: { ...DEFAULT_EXPORT_CFG },
    sheet: { ...DEFAULT_SHEET },
    materialId: state.materials[0]?.id ?? '',
    layerNames: ['图层 1'],
    batch: { enabled: false, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' },
  }
}

export function createProjectFromShapes(name: string, shapes: Shape[]): Project {
  const p = newProject(name, shapes)
  state.projects.unshift(p)
  recomputeProject(p, true)
  scheduleSave()
  return p
}

export function createBlankProject(name: string): Project {
  return createProjectFromShapes(name, [{ id: uid('s'), name: '新建形状', contours: [], layer: 0 }])
}

export function getProject(id: string): Project | undefined {
  return state.projects.find((p) => p.id === id)
}

export function deleteProject(id: string): void {
  const i = state.projects.findIndex((p) => p.id === id)
  if (i >= 0) {
    state.projects.splice(i, 1)
    scheduleSave()
  }
}

export function duplicateProject(id: string): Project | null {
  const src = getProject(id)
  if (!src) return null
  const copy: Project = JSON.parse(JSON.stringify(src))
  copy.id = uid('p')
  copy.name = `${src.name} 副本`
  copy.createdAt = Date.now()
  copy.updatedAt = Date.now()
  // 重新分配 id，避免缓存串用
  for (const s of copy.shapes) {
    s.id = uid('s')
    for (const c of s.contours) c.id = uid('c')
    for (const c of s.contours) {
      c.holes = []
      c.bridges = []
    }
  }
  state.projects.unshift(copy)
  recomputeProject(copy, true)
  scheduleSave()
  return copy
}

export function touch(p: Project): void {
  p.updatedAt = Date.now()
  scheduleSave()
}

export function addShape(p: Project, shape: Shape): void {
  p.shapes.push(shape)
  recomputeProject(p, true)
  touch(p)
}

export function removeShape(p: Project, shapeId: string): void {
  const i = p.shapes.findIndex((s) => s.id === shapeId)
  if (i >= 0) {
    p.shapes.splice(i, 1)
    delete computedCache[shapeId]
    touch(p)
  }
}

export function updateSettings(p: Project, patch: Partial<CutSettings>): void {
  Object.assign(p.settings, patch)
  recomputeProject(p, true)
  touch(p)
}

export function updateExport(p: Project, patch: Partial<ExportCfg>): void {
  Object.assign(p.export, patch)
  touch(p)
}

export function updateSheet(p: Project, sheet: Sheet): void {
  p.sheet = { ...sheet }
  touch(p)
}

export function updateBatch(p: Project, patch: Partial<BatchCfg>): void {
  if (!p.batch) p.batch = { enabled: false, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' }
  Object.assign(p.batch, patch)
  touch(p)
}

export function setMaterial(p: Project, materialId: string): void {
  p.materialId = materialId
  recomputeProject(p, true)
  touch(p)
}

/** 一键闭合所有未闭合轮廓 */
export function closeAllOpen(p: Project): number {
  let n = 0
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (!c.closed && c.points.length >= 3) {
        c.closed = true
        c.warnings = c.warnings.filter((w) => w !== 'not_closed')
        n += 1
      }
    }
  }
  if (n > 0) {
    recomputeProject(p, true)
    touch(p)
  }
  return n
}

export function closeContour(p: Project, contourId: string): boolean {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (c.id === contourId && !c.closed && c.points.length >= 3) {
        c.closed = true
        c.warnings = c.warnings.filter((w) => w !== 'not_closed')
        recomputeProject(p, true)
        touch(p)
        return true
      }
    }
  }
  return false
}

export function removeContour(p: Project, contourId: string): void {
  for (const shape of p.shapes) {
    const i = shape.contours.findIndex((c) => c.id === contourId)
    if (i >= 0) {
      shape.contours.splice(i, 1)
      recomputeProject(p, true)
      touch(p)
      return
    }
  }
}

/** 手工放置连刀点：在指定轮廓上离 p 最近的顶点处 */
export function placeManualBridge(p: Project, contourId: string, atIndex: number): void {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (c.id !== contourId) continue
      if (!c.bridges.some((b) => b.atIndex === atIndex)) {
        c.bridges.push({ atIndex, widthMm: p.settings.bridgeWidthMm })
      }
      recomputeProject(p, true)
      touch(p)
      return
    }
  }
}

export function clearManualBridges(p: Project, contourId?: string): void {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (contourId && c.id !== contourId) continue
      c.bridges = []
    }
  }
  recomputeProject(p, true)
  touch(p)
}

/** 纹样对称生成：镜像 / 旋转 / 四方连续 */
export function applySymmetry(p: Project, shapeId: string, op: 'mirror_x' | 'mirror_y' | 'rotate_90' | 'rotate_180' | 'four_way'): void {
  const shape = p.shapes.find((s) => s.id === shapeId)
  if (!shape) return
  const all = shape.contours.flatMap((c) => c.points)
  if (all.length === 0) return
  const minX = Math.min(...all.map((q) => q.x))
  const maxX = Math.max(...all.map((q) => q.x))
  const minY = Math.min(...all.map((q) => q.y))
  const maxY = Math.max(...all.map((q) => q.y))

  const makeCopy = (fn: (x: number, y: number) => { x: number; y: number }): Shape => {
    const contours = shape.contours.map((c) => {
      const pts = c.points.map((q) => {
        const r = fn(q.x, q.y)
        return { x: Math.round(r.x * 1000) / 1000, y: Math.round(r.y * 1000) / 1000 }
      })
      return { ...c, id: uid('c'), points: pts, holes: [], bridges: [], warnings: [] }
    })
    return { id: uid('s'), name: `${shape.name} 对称`, contours, layer: shape.layer }
  }

  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const ops: Array<(x: number, y: number) => { x: number; y: number }> = []
  if (op === 'mirror_x') ops.push((x, y) => ({ x: minX + maxX - x, y }))
  if (op === 'mirror_y') ops.push((x, y) => ({ x, y: minY + maxY - y }))
  if (op === 'rotate_90') ops.push((x, y) => ({ x: cx - (y - cy), y: cy + (x - cx) }))
  if (op === 'rotate_180') ops.push((x, y) => ({ x: 2 * cx - x, y: 2 * cy - y }))
  if (op === 'four_way') {
    ops.push((x, y) => ({ x: minX + maxX - x, y }))
    ops.push((x, y) => ({ x, y: minY + maxY - y }))
    ops.push((x, y) => ({ x: minX + maxX - x, y: minY + maxY - y }))
  }
  for (const fn of ops) p.shapes.push(makeCopy(fn))
  recomputeProject(p, true)
  touch(p)
}

// ---------------- 材料预设 ----------------

export function upsertMaterial(m: MaterialPreset): void {
  const i = state.materials.findIndex((x) => x.id === m.id)
  if (i >= 0) state.materials[i] = { ...m }
  else state.materials.push({ ...m })
  scheduleSave()
}

export function deleteMaterial(id: string): void {
  const i = state.materials.findIndex((x) => x.id === id)
  if (i >= 0 && state.materials.length > 1) {
    state.materials.splice(i, 1)
    for (const p of state.projects) {
      if (p.materialId === id) {
        p.materialId = state.materials[0].id
        recomputeProject(p, true)
      }
    }
    scheduleSave()
  }
}

// ---------------- 刀具台账 ----------------

export function mountedBlade(): Blade | null {
  const id = state.ledger.mountedBladeId
  return state.ledger.blades.find((b) => b.id === id) ?? null
}

export type NewBladeParams = {
  name: string
  angleDeg: number
  mountedAt?: number
  wearLimit?: number
  note?: string
}

/** 登记新刀：记录上机时间与刀刃角度。默认直接装到机器上（首把刀）。 */
export function registerBlade(params: NewBladeParams, mount = true): Blade {
  const blade: Blade = {
    id: uid('blade'),
    name: params.name.trim() || '未命名刀',
    angleDeg: normalizeAngle(params.angleDeg),
    mountedAt: params.mountedAt ?? Date.now(),
    status: 'active',
    wearLimit: clampWearLimit(params.wearLimit ?? DEFAULT_BLADE_WEAR_LIMIT),
    wearFactors: defaultFactorTable(),
    note: params.note?.trim() || undefined,
  }
  state.ledger.blades.push(blade)
  if (mount || !state.ledger.mountedBladeId) state.ledger.mountedBladeId = blade.id
  scheduleSave()
  return blade
}

/** 修改刀档（名称/角度/上限/备注）。上限改小后若已超限，下一次记账会自动退役。 */
export function updateBlade(id: string, patch: Partial<Pick<Blade, 'name' | 'angleDeg' | 'wearLimit' | 'note'>>): void {
  const b = state.ledger.blades.find((x) => x.id === id)
  if (!b) return
  if (typeof patch.name === 'string') b.name = patch.name.trim() || b.name
  if (patch.angleDeg !== undefined) b.angleDeg = normalizeAngle(patch.angleDeg)
  if (patch.wearLimit !== undefined) b.wearLimit = clampWearLimit(patch.wearLimit)
  if (patch.note !== undefined) b.note = patch.note.trim() || undefined
  reconcileBlade(b)
  scheduleSave()
}

/** 调同一把刀在某纸张上的折算系数；历史磨损不迁移 —— 由流水按新系数自动重算。 */
export function setBladeFactor(bladeId: string, paper: string, factor: number): void {
  const b = state.ledger.blades.find((x) => x.id === bladeId)
  if (!b) return
  const f = Number(factor)
  if (!Number.isFinite(f) || f < 0) return
  b.wearFactors[paper] = Math.round(f * 1000) / 1000
  reconcileBlade(b)
  scheduleSave()
}

/** 调完上限/系数后复核：在役刀重新达到上限立即退役；反之到顶退役的刀若又回到上限内则复活 */
function reconcileBlade(b: Blade): void {
  const s = bladeStats(b, state.ledger.cuts)
  if (b.status === 'active' && s.wornOut) {
    b.status = 'retired'
    b.retireReason = 'limit'
  } else if (b.status === 'retired' && b.retireReason === 'limit' && !s.wornOut) {
    b.status = 'active'
    b.retireReason = undefined
  }
}

export type CutLogInput = {
  bladeId?: string
  paper: string
  paperLabel?: string
  /** 整场刀路总长 mm（多形状/多图层/排版份数的全场总量，不含跳刀） */
  lengthMm: number
  passes: number
  force: number
  speedMmS: number
  jobName?: string
  at?: number
}

export type CutLogResult = {
  cut: CutRecord
  blade: Blade
  /** 记账后该刀是否达到上限（已自动退役、移出可选列表） */
  wornOut: boolean
}

/**
 * 完成一次切割后记一笔磨损：按这场实际刀路长度 × 纸张 × 遍数折算并累加。
 * 到上限则提醒（返回 wornOut）并把刀从可选列表挪出去（退役）。
 */
export function logCut(input: CutLogInput): CutLogResult | null {
  const bladeId = input.bladeId ?? state.ledger.mountedBladeId
  const blade = state.ledger.blades.find((b) => b.id === bladeId && b.status === 'active')
  if (!blade) return null
  const cut: CutRecord = {
    id: uid('cut'),
    bladeId: blade.id,
    at: input.at ?? Date.now(),
    paper: input.paper,
    paperLabel: input.paperLabel?.trim() || input.paper,
    lengthMm: Math.max(0, Number(input.lengthMm) || 0),
    passes: Math.max(1, Math.round(Number(input.passes) || 1)),
    force: Number(input.force) || 0,
    speedMmS: Number(input.speedMmS) || 0,
    jobName: input.jobName?.trim() || undefined,
  }
  state.ledger.cuts.push(cut)
  let wornOut = false
  const s = bladeStats(blade, state.ledger.cuts)
  if (s.wornOut) {
    wornOut = true
    blade.status = 'retired'
    blade.retireReason = 'limit'
  }
  scheduleSave()
  return { cut, blade, wornOut }
}

/** 删错账：删掉流水后按当前系数重算；若刀因此回到上限内，自动复活并重新可选。 */
export function deleteCut(cutId: string): void {
  const i = state.ledger.cuts.findIndex((c) => c.id === cutId)
  if (i < 0) return
  const bladeId = state.ledger.cuts[i].bladeId
  state.ledger.cuts.splice(i, 1)
  const b = state.ledger.blades.find((x) => x.id === bladeId)
  if (b) reconcileBlade(b)
  scheduleSave()
}

export type BladeChangeResult = {
  log: BladeChangeLog
  newBlade: Blade
}

/**
 * 换刀：把旧刀卸下（退役），记一笔旧刀累计磨损、总切割米数与换上的新刀。
 * 新刀可以是已登记的备用刀（existingBladeId），也可以当场新登记（newBlade 参数）。
 */
export function changeBlade(params: {
  oldBladeId?: string
  existingBladeId?: string
  newBlade?: NewBladeParams
  reason?: RetireReason
  note?: string
}): BladeChangeResult | null {
  const oldId = params.oldBladeId ?? state.ledger.mountedBladeId
  const old = state.ledger.blades.find((b) => b.id === oldId)
  if (!old) return null

  let next: Blade | null = null
  if (params.existingBladeId) {
    next = state.ledger.blades.find((b) => b.id === params.existingBladeId && b.status === 'active' && b.id !== old.id) ?? null
  } else if (params.newBlade) {
    next = registerBlade(params.newBlade, false)
  }
  if (!next) return null

  const reason: RetireReason = params.reason ?? (old.status === 'retired' && old.retireReason === 'limit' ? 'limit' : 'manual')
  const snap = snapshotRetire(old, state.ledger.cuts, reason)
  old.status = 'retired'
  old.retireReason = reason
  const log: BladeChangeLog = {
    id: uid('chg'),
    at: Date.now(),
    bladeId: old.id,
    bladeName: old.name,
    wearAtRetire: snap.wearAtRetire,
    wearLimit: old.wearLimit,
    totalMetersAtRetire: snap.totalMetersAtRetire,
    reason,
    newBladeId: next.id,
    newBladeName: next.name,
    note: params.note?.trim() || undefined,
  }
  state.ledger.changes.unshift(log)
  state.ledger.mountedBladeId = next.id
  scheduleSave()
  return { log, newBlade: next }
}

/** 还没装刀时装第一把刀（在役刀之间互换请走 changeBlade 留账） */
export function mountBlade(bladeId: string): boolean {
  if (state.ledger.mountedBladeId) return false
  const b = state.ledger.blades.find((x) => x.id === bladeId && x.status === 'active')
  if (!b) return false
  state.ledger.mountedBladeId = b.id
  scheduleSave()
  return true
}

/** 手动退役一把无流水的备用刀（有账的刀请走换刀流程，避免账与刀脱钩） */
export function removeBlade(bladeId: string): void {
  const hasCuts = state.ledger.cuts.some((c) => c.bladeId === bladeId)
  if (hasCuts) return
  const i = state.ledger.blades.findIndex((b) => b.id === bladeId)
  if (i < 0) return
  state.ledger.blades.splice(i, 1)
  if (state.ledger.mountedBladeId === bladeId) state.ledger.mountedBladeId = null
  scheduleSave()
}

// ---------------- 导入 ----------------

export function importSvgToShapes(
  text: string,
  name: string,
  settings: CutSettings,
): { result: ImportResult; shape: Shape } {
  const result = importSvgText(text, { toleranceMm: settings.toleranceMm, closeToleranceMm: settings.closeToleranceMm })
  const shape: Shape = { id: uid('s'), name, contours: result.contours, layer: 0 }
  return { result, shape }
}

export function addImportedShapes(p: Project, shapes: Shape[]): void {
  for (const s of shapes) p.shapes.push(s)
  recomputeProject(p, true)
  touch(p)
}

watch(
  () => [state.projects, state.materials, state.ledger],
  () => {
    if (state.ready) scheduleSave()
  },
  { deep: true },
)

export const store = {
  state,
  loadState,
  saveNow,
  scheduleSave,
  materialOf,
  getProject,
  computedOf,
  jobOf,
  layerOrderOf,
  createProjectFromShapes,
  createBlankProject,
  deleteProject,
  duplicateProject,
  addShape,
  addImportedShapes,
  removeShape,
  updateSettings,
  updateExport,
  updateSheet,
  updateBatch,
  setMaterial,
  closeAllOpen,
  closeContour,
  removeContour,
  placeManualBridge,
  clearManualBridges,
  applySymmetry,
  upsertMaterial,
  deleteMaterial,
  recomputeProject,
  recomputeAll,
  importSvgToShapes,
  touch,
  // 刀具台账
  mountedBlade,
  registerBlade,
  updateBlade,
  setBladeFactor,
  logCut,
  deleteCut,
  changeBlade,
  mountBlade,
  removeBlade,
}