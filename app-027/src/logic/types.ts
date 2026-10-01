/** 内部统一单位：毫米 mm（浮点保留 3 位小数） */
export type Pt = { x: number; y: number }

export type ContourWarning =
  | 'not_closed'
  | 'self_intersect'
  | 'duplicate'
  | 'offset_clipped'
  | 'offset_failed'
  | 'bridge_degraded'
  | 'too_short'

/** 连刀点：atIndex 为锚点在 points 中的顶点下标，widthMm 为缺口宽度 */
export type Bridge = { atIndex: number; widthMm: number }

export type Contour = {
  id: string
  points: Pt[]
  closed: boolean
  /** 派分值：面积（mm²），闭合轮廓的净面积 */
  area: number
  /** 派分值：周长（mm） */
  length: number
  /** 直接子轮廓（内层）id */
  holes: string[]
  bridges: Bridge[]
  warnings: ContourWarning[]
}

export type Shape = { id: string; name: string; contours: Contour[]; layer: number }

export type MaterialPreset = {
  id: string
  name: string
  paper: string
  force: number
  speedMmS: number
  passes: number
  bladeOffsetMm: number
  /** 垫板 */
  backing: string
}

export type CutSettings = {
  order: 'inner_first'
  bridgeRule: 'by_area' | 'by_length' | 'manual'
  areaThresholdMm2: number
  bridgeWidthMm: number
  bridgeEveryMm: number
  travelOptimize: 'nearest' | 'nearest_2opt'
  /** 贝塞尔离散化容差（mm） */
  toleranceMm: number
  /** 闭合判定容差（mm） */
  closeToleranceMm: number
  /** 是否启用刀补偏置 */
  useBladeOffset: boolean
}

export type ExportCfg = {
  format: 'plt' | 'gcode' | 'svg'
  unit: 'mm' | '0.025mm'
  origin: 'bottom_left' | 'top_left'
  yFlip: boolean
  scale: number
}

export type Sheet = { widthMm: number; heightMm: number; name: string }

/** 项目（保存到本地存储） */
export type Project = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  shapes: Shape[]
  settings: CutSettings
  export: ExportCfg
  sheet: Sheet
  materialId: string
  /** 图层名（多色纸分层切割） */
  layerNames: string[]
  /** 批量排版配置 */
  batch?: BatchCfg
  /** 批量排版的对象形状（同一纹样排满一张纸） */
  batchShapeId?: string
}

export type BatchCfg = {
  enabled: boolean
  rows: number
  cols: number
  gapXMm: number
  gapYMm: number
  /** 共边裁切：间距为 0 时相邻轮廓共边，重叠路径只切一次 */
  sharedEdge: boolean
  mode: 'repeat' | 'four_way'
}

export const DEFAULT_CUT_SETTINGS: CutSettings = {
  order: 'inner_first',
  bridgeRule: 'by_area',
  areaThresholdMm2: 4,
  bridgeWidthMm: 0.5,
  bridgeEveryMm: 12,
  travelOptimize: 'nearest_2opt',
  toleranceMm: 0.15,
  closeToleranceMm: 0.2,
  useBladeOffset: false,
}

export const DEFAULT_EXPORT_CFG: ExportCfg = {
  format: 'plt',
  unit: '0.025mm',
  origin: 'bottom_left',
  yFlip: true,
  scale: 1,
}

export const DEFAULT_SHEET: Sheet = { widthMm: 210, heightMm: 297, name: 'A4 纵向' }

export const A4_LANDSCAPE: Sheet = { widthMm: 297, heightMm: 210, name: 'A4 横向' }
export const SHEET_PRESETS: Sheet[] = [
  DEFAULT_SHEET,
  A4_LANDSCAPE,
  { widthMm: 300, heightMm: 300, name: '300×300 方纸' },
  { widthMm: 400, heightMm: 600, name: '400×600 宣纸' },
  { widthMm: 600, heightMm: 600, name: '600×600 大字纸' },
]

/** 纸张 / 材料（材料参数卡用） */
export type PaperKind = {
  paper: string
  label: string
  force: number
  speedMmS: number
  passes: number
  backing: string
  note: string
}

export const PAPER_KINDS: PaperKind[] = [
  {
    paper: 'cardstock',
    label: '卡纸',
    force: 120,
    speedMmS: 40,
    passes: 1,
    backing: '蓝色中硬垫板',
    note: '白卡 / 黑卡 200~300g，垫板硬度中等',
  },
  { paper: 'xuan', label: '宣纸', force: 60, speedMmS: 60, passes: 2, backing: '白色软垫板', note: '宣纸脆薄，多次轻切优于一次重切' },
  { paper: 'sticker', label: '不干胶', force: 90, speedMmS: 55, passes: 1, backing: '不粘垫板', note: '仅切穿面纸，勿伤底纸' },
  { paper: 'flock', label: '植绒', force: 150, speedMmS: 25, passes: 2, backing: '硬质垫板', note: '绒毛纤维阻力大，刀压高、速度慢' },
  { paper: 'kraft', label: '牛皮纸', force: 110, speedMmS: 45, passes: 1, backing: '蓝色中硬垫板', note: '常规包装打样' },
  {
    paper: 'red-paper',
    label: '红纸（剪纸）',
    force: 85,
    speedMmS: 50,
    passes: 1,
    backing: '白色软垫板',
    note: '非遗剪纸常用，注意连刀点宽度',
  },
]

// ---------------- 刀具台账 ----------------

/** 刀具状态：active 在用/备用可选；retired 已换下（磨损到顶或手动退役），不再出现在可选列表 */
export type BladeStatus = 'active' | 'retired'

/** 换下原因：limit 磨损累计到上限；manual 手动提前换刀 */
export type RetireReason = 'limit' | 'manual'

/**
 * 每把刀的档案：登记上机时间与刀刃角度，挂着它的全部切割流水。
 * 磨损不直接落库，而是按流水（长度 × 纸张系数 × 遍数）实时折算，
 * 这样改了某纸张的折算系数后，已经累计的量会自动跟着重算。
 */
export type Blade = {
  id: string
  /** 刀号/名称，如「45°-03」 */
  name: string
  /** 刀刃角度（度），常见 30 / 45 / 60 */
  angleDeg: number
  /** 登记上机时间（ms 时间戳） */
  mountedAt: number
  status: BladeStatus
  /** 磨损上限（磨损点），累计达到即提醒换刀并移出可选列表 */
  wearLimit: number
  /** 该刀在各纸张上的折算系数：每米刀路产生多少磨损点，可逐纸单独调 */
  wearFactors: Record<string, number>
  /** 换下时记录原因 */
  retireReason?: RetireReason
  note?: string
}

/**
 * 一次切割流水：多形状、多图层的活按整场总量汇总成一条。
 * 纸张/遍数/刀压速度在记账时快照，之后改材料预设不影响旧账；
 * 只存原始长度与遍数，磨损量由当前折算系数重算。
 */
export type CutRecord = {
  id: string
  bladeId: string
  /** 切割完成时间（ms 时间戳） */
  at: number
  /** 纸张种类（材料预设的 paper key，记账时快照） */
  paper: string
  /** 纸张名称快照（材料预设 label），预设删除/改名后旧账仍可读 */
  paperLabel: string
  /** 本场实际切出的刀路总长 mm（不含跳刀，已含多形状/多图层/排版份数的全场总量） */
  lengthMm: number
  /** 实际重复遍数（记账时从材料预设快照带出，可在记账时修正） */
  passes: number
  /** 刀压快照 */
  force: number
  /** 速度快照 mm/s */
  speedMmS: number
  /** 活名/备注，如项目名 */
  jobName?: string
}

/** 换刀记录：旧刀卸下时的累计磨损、总切割里程，以及换上的新刀 */
export type BladeChangeLog = {
  id: string
  at: number
  /** 换下的旧刀 */
  bladeId: string
  bladeName: string
  /** 旧刀卸下瞬间的累计磨损（磨损点，按当时系数折算并固化） */
  wearAtRetire: number
  wearLimit: number
  /** 旧刀一共切了多少米（按流水长度 × 遍数计） */
  totalMetersAtRetire: number
  /** 换下原因 */
  reason: RetireReason
  /** 换上的刀（可能是已登记的备用刀，也可能是当场新登记的刀） */
  newBladeId: string
  newBladeName: string
  note?: string
}

/** 刀具台账全部持久化数据 */
export type BladeLedger = {
  blades: Blade[]
  cuts: CutRecord[]
  changes: BladeChangeLog[]
  /** 当前装在机器上的刀；无刀（null）时切割记账需先选刀/登记新刀 */
  mountedBladeId: string | null
}

/** 各纸张默认折算系数：每米刀路的磨损点（植绒最费刀，宣纸/不干胶较省） */
export const DEFAULT_WEAR_FACTORS: Record<string, number> = {
  cardstock: 1.0,
  xuan: 0.6,
  sticker: 0.5,
  flock: 1.8,
  kraft: 1.1,
  'red-paper': 0.9,
}

/** 未单独配置系数的纸张（含自定义纸张）回退系数 */
export const FALLBACK_WEAR_FACTOR = 1.0

/** 新刀默认磨损上限（磨损点 ≈ 米数的经验尺度） */
export const DEFAULT_BLADE_WEAR_LIMIT = 200

/** 常用刀刃角度（度） */
export const BLADE_ANGLES = [30, 45, 60] as const