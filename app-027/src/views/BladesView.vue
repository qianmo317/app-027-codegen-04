<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { state, store } from '@/logic/store'
import { PAPER_KINDS, BLADE_ANGLES, type Blade, type CutRecord } from '@/logic/types'
import {
  bladeStats,
  changeCountOf,
  fmtDateTime,
  fmtNum,
  recentChanges,
  selectableBlades,
  wearFactorOf,
  wearOfCut,
  type BladeStats,
} from '@/logic/blade'

// ---------------- 派生数据 ----------------

type Row = { blade: Blade; stats: BladeStats; changes: number }

function rowOf(b: Blade): Row {
  return { blade: b, stats: bladeStats(b, state.ledger.cuts), changes: changeCountOf(state.ledger.changes, b.id) }
}

const activeRows = computed<Row[]>(() =>
  state.ledger.blades
    .filter((b) => b.status === 'active')
    .map(rowOf)
    .sort((a, b) => b.stats.wear - a.stats.wear),
)

const retiredRows = computed<Row[]>(() =>
  state.ledger.blades
    .filter((b) => b.status === 'retired')
    .map(rowOf)
    .sort((a, b) => b.blade.mountedAt - a.blade.mountedAt),
)

const mounted = computed(() => store.mountedBlade())
const mountedRow = computed(() => (mounted.value ? rowOf(mounted.value) : null))
const available = computed(() => selectableBlades(state.ledger.blades, state.ledger.cuts))

const changes = computed(() => recentChanges(state.ledger.changes, 8))

function paperText(key: string): string {
  return PAPER_KINDS.find((p) => p.paper === key)?.label ?? key
}

// ---------------- 登记新刀 ----------------

const newForm = ref<{ name: string; angleDeg: number; wearLimit: number; note: string } | null>(null)
const formError = ref('')

function startRegister(): void {
  const n = state.ledger.blades.length + 1
  newForm.value = {
    name: `新刀 ${String(n).padStart(2, '0')}`,
    angleDeg: 45,
    wearLimit: mounted.value?.wearLimit ?? 200,
    note: '',
  }
  formError.value = ''
}

function confirmRegister(): void {
  if (!newForm.value) return
  if (!newForm.value.name.trim()) {
    formError.value = '刀号不能为空'
    return
  }
  store.registerBlade({
    name: newForm.value.name,
    angleDeg: newForm.value.angleDeg,
    wearLimit: newForm.value.wearLimit,
    note: newForm.value.note,
  })
  notice.value = `已登记并装上新刀「${newForm.value.name.trim()}」`
  newForm.value = null
}

// ---------------- 编辑刀档（上限 / 角度 / 备注） ----------------

const editingId = ref<string | null>(null)
const editForm = ref<{ name: string; angleDeg: number; wearLimit: number; note: string } | null>(null)

function startEdit(b: Blade): void {
  editingId.value = b.id
  editForm.value = { name: b.name, angleDeg: b.angleDeg, wearLimit: b.wearLimit, note: b.note ?? '' }
}

function saveEdit(): void {
  if (!editingId.value || !editForm.value) return
  store.updateBlade(editingId.value, { ...editForm.value })
  notice.value = '刀档已更新，累计磨损已按现有流水重算'
  editingId.value = null
  editForm.value = null
}

// ---------------- 折算系数（每把刀 × 每种纸单独调） ----------------

const factorBladeId = ref<string | null>(null)
const factorDraft = ref<Record<string, number>>({})

const factorPapers = computed(() => {
  // 内置纸张 + 流水里出现过的自定义纸张
  const keys = new Set<string>(PAPER_KINDS.map((p) => p.paper))
  const b = factorBlade()
  if (b) for (const c of state.ledger.cuts) if (c.bladeId === b.id) keys.add(c.paper)
  return Array.from(keys)
})

function factorBlade(): Blade | null {
  return state.ledger.blades.find((x) => x.id === factorBladeId.value) ?? null
}

const factorRow = computed(() => {
  const b = factorBlade()
  return b ? bladeStats(b, state.ledger.cuts) : null
})

function startFactors(b: Blade): void {
  factorBladeId.value = b.id
  factorDraft.value = {}
  for (const key of factorPapers.value) factorDraft.value[key] = wearFactorOf(b, key)
}

function saveFactors(): void {
  const id = factorBladeId.value
  if (!id) return
  for (const [paper, f] of Object.entries(factorDraft.value)) store.setBladeFactor(id, paper, f)
  const b = factorBlade()
  notice.value = `「${b?.name ?? ''}」的纸张折算系数已更新，历史磨损已按新系数重算`
  factorBladeId.value = null
}

// ---------------- 切割记账 ----------------

const cutBladeId = ref<string | null>(null)

const cutForm = reactive({
  paper: 'cardstock',
  lengthMm: 0 as number,
  passes: 1,
  jobName: '',
})

const cutError = ref('')

function startCut(b?: Blade): void {
  // 装机刀已磨损到顶时，预选列表里第一把可选刀
  const requested = b ?? mounted.value ?? null
  const pick = requested && available.value.some((x) => x.id === requested.id)
    ? requested
    : available.value[0] ?? null
  cutBladeId.value = pick?.id ?? null
  const paper = PAPER_KINDS.find((p) => p.paper === currentMaterialPaper.value) ?? PAPER_KINDS[0]
  cutForm.paper = paper.paper
  cutForm.lengthMm = 0
  cutForm.passes = paper.passes
  cutForm.jobName = ''
  cutError.value = ''
}

/** 记账表单默认纸张跟随项目里常用的材料预设（仅做默认值，账里存快照） */
const currentMaterialPaper = computed(() => state.materials[0]?.paper ?? 'cardstock')

const cutBlade = computed(() => state.ledger.blades.find((b) => b.id === cutBladeId.value) ?? null)

const cutPreview = computed(() => {
  const b = cutBlade.value
  if (!b || cutForm.lengthMm <= 0) return { wear: 0, factor: 0, meters: 0 }
  const factor = wearFactorOf(b, cutForm.paper)
  const meters = (cutForm.lengthMm / 1000) * Math.max(1, Math.round(cutForm.passes))
  return { wear: meters * factor, factor, meters }
})

const cutAfterStats = computed(() => {
  const b = cutBlade.value
  if (!b) return null
  const base = bladeStats(b, state.ledger.cuts)
  return {
    wear: base.wear + cutPreview.value.wear,
    remaining: Math.max(0, b.wearLimit - base.wear - cutPreview.value.wear),
  }
})

function presetOfPaper(paper: string) {
  return state.materials.find((m) => m.paper === paper) ?? state.materials[0] ?? null
}

function onCutPaperChange(): void {
  const k = PAPER_KINDS.find((p) => p.paper === cutForm.paper)
  if (k) cutForm.passes = k.passes
}

function confirmCut(): void {
  const b = cutBlade.value
  cutError.value = ''
  if (!b) {
    cutError.value = '请先选择或登记一把刀'
    return
  }
  if (!(cutForm.lengthMm > 0)) {
    cutError.value = '刀路长度需大于 0（多形状/多图层按整场总量填）'
    return
  }
  const preset = presetOfPaper(cutForm.paper)
  const res = store.logCut({
    bladeId: b.id,
    paper: cutForm.paper,
    paperLabel: paperText(cutForm.paper),
    lengthMm: cutForm.lengthMm,
    passes: cutForm.passes,
    force: preset?.force ?? 0,
    speedMmS: preset?.speedMmS ?? 0,
    jobName: cutForm.jobName,
  })
  if (!res) {
    cutError.value = '记账失败：该刀不在可选列表中（可能已磨损到顶）'
    return
  }
  const s = bladeStats(res.blade, state.ledger.cuts)
  notice.value = res.wornOut
    ? `「${res.blade.name}」累计磨损已到上限 ${res.blade.wearLimit}，该换刀了（已移出可选列表）`
    : `已记一笔：${fmtNum(cutPreview.value.wear)} 磨损点（${res.blade.name} 累计 ${fmtNum(s.wear)}）`
  cutBladeId.value = null
}

// ---------------- 换刀 ----------------

const changeOldId = ref<string | null>(null)
const changeMode = ref<'existing' | 'new'>('new')
const changeExistingId = ref<string>('')
const changeForm = ref({ name: '', angleDeg: 45, wearLimit: 200, note: '' })
const changeError = ref('')

function startChange(b?: Blade): void {
  changeOldId.value = b?.id ?? mounted.value?.id ?? null
  changeMode.value = 'new'
  const spare = state.ledger.blades.find(
    (x) => x.status === 'active' && x.id !== changeOldId.value && !bladeStats(x, state.ledger.cuts).wornOut,
  )
  changeExistingId.value = spare?.id ?? ''
  const n = state.ledger.blades.length + 1
  changeForm.value = {
    name: `新刀 ${String(n).padStart(2, '0')}`,
    angleDeg: b?.angleDeg ?? 45,
    wearLimit: b?.wearLimit ?? 200,
    note: '',
  }
  changeError.value = ''
}

const changeOld = computed(() => state.ledger.blades.find((b) => b.id === changeOldId.value) ?? null)
const changeOldStats = computed(() => (changeOld.value ? bladeStats(changeOld.value, state.ledger.cuts) : null))

const spareBlades = computed(() =>
  changeOldId.value ? available.value.filter((b) => b.id !== changeOldId.value) : available.value,
)

function confirmChange(): void {
  changeError.value = ''
  const old = changeOld.value
  if (!old) {
    changeError.value = '没有要换下的旧刀'
    return
  }
  let params: Parameters<typeof store.changeBlade>[0]
  if (changeMode.value === 'existing') {
    if (!changeExistingId.value) {
      changeError.value = '请选择一把备用刀'
      return
    }
    params = { oldBladeId: old.id, existingBladeId: changeExistingId.value, note: changeForm.value.note }
  } else {
    if (!changeForm.value.name.trim()) {
      changeError.value = '新刀刀号不能为空'
      return
    }
    params = {
      oldBladeId: old.id,
      newBlade: {
        name: changeForm.value.name,
        angleDeg: changeForm.value.angleDeg,
        wearLimit: changeForm.value.wearLimit,
        note: changeForm.value.note,
      },
    }
  }
  const res = store.changeBlade(params)
  if (!res) {
    changeError.value = '换刀失败：请检查旧刀与新刀选择'
    return
  }
  notice.value =
    `已换刀：${res.log.bladeName}（卸下时磨损 ${res.log.wearAtRetire}/${res.log.wearLimit}，` +
    `共切 ${res.log.totalMetersAtRetire}m）→ ${res.newBlade.name}`
  changeOldId.value = null
}

// ---------------- 流水 / 杂项 ----------------

const notice = ref('')

const recentCuts = computed(() =>
  state.ledger.cuts
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, 12),
)

function bladeName(id: string): string {
  return state.ledger.blades.find((b) => b.id === id)?.name ?? '（已删除）'
}

/** 一条流水按其刀具当前系数折算的磨损点（系数调整后随表格实时重算） */
function cutWear(c: CutRecord): number {
  const b = state.ledger.blades.find((x) => x.id === c.bladeId)
  return b ? wearOfCut(c, b) : 0
}

function removeCut(c: CutRecord): void {
  if (!confirm(`删除这条切割流水（${paperText(c.paper)} ${fmtNum(c.lengthMm / 1000, 3)}m）？累计磨损将重算。`)) return
  store.deleteCut(c.id)
  notice.value = '流水已删除，磨损已重算'
}

function removeIdleBlade(b: Blade): void {
  if (state.ledger.cuts.some((c) => c.bladeId === b.id)) {
    notice.value = '该刀有切割流水，不能直接删除，请走换刀流程'
    return
  }
  if (!confirm(`删除刀档「${b.name}」？`)) return
  store.removeBlade(b.id)
}

function reasonText(r: 'limit' | 'manual'): string {
  return r === 'limit' ? '磨损到顶' : '手动换刀'
}

function barClass(r: Row): string {
  if (r.stats.wornOut) return 'bar err'
  if (r.stats.usedRatio >= 0.8) return 'bar warn'
  return 'bar ok'
}
</script>

<template>
  <div class="page">
    <div class="page narrow">
      <h1>刀具台账</h1>
      <p class="hint">
        登记每把刀的上机时间与刀刃角度；每完成一场切割，按实际刀路长度 × 纸张折算系数 × 重复遍数累加磨损。
        多形状、多图层的活按整场总量计。累计到上限即提醒换刀，并把旧刀移出可选列表。
      </p>

      <div v-if="notice" class="banner ok">{{ notice }}</div>

      <!-- 当前装机 -->
      <div class="card mounted-card">
        <template v-if="mountedRow">
          <div class="mounted-main">
            <div class="mounted-title">
              <span class="tag accent">当前装机</span>
              <strong>{{ mountedRow.blade.name }}</strong>
              <span class="tag mono">{{ mountedRow.blade.angleDeg }}° 刀刃</span>
              <span class="tag">上机 {{ fmtDateTime(mountedRow.blade.mountedAt) }}</span>
            </div>
            <div class="life-line">
              <div class="bar-track">
                <div
                  :class="barClass(mountedRow)"
                  :style="{ width: mountedRow.stats.remainingPct + '%' }"
                ></div>
              </div>
              <div class="life-nums">
                剩余寿命 <strong>{{ fmtNum(mountedRow.stats.remaining) }}</strong> / {{ fmtNum(mountedRow.blade.wearLimit) }}
                磨损点（已用 {{ fmtNum(mountedRow.stats.wear) }}）
              </div>
            </div>
          </div>
          <div class="mounted-meta">
            <div class="stat"><div class="k">累计切割</div><div class="v">{{ fmtNum(mountedRow.stats.totalMeters) }}<small>m</small></div></div>
            <div class="stat"><div class="k">切割场次</div><div class="v">{{ mountedRow.stats.cutCount }}<small>场</small></div></div>
            <div class="stat"><div class="k">本刀换过</div><div class="v">{{ mountedRow.changes }}<small>次</small></div></div>
          </div>
          <div class="mounted-actions">
            <button class="primary" @click="startCut(mountedRow.blade)">记一次切割</button>
            <button @click="startChange(mountedRow.blade)">换刀</button>
            <button class="tiny" @click="startFactors(mountedRow.blade)">调折算系数</button>
          </div>
          <div v-if="mountedRow.stats.wornOut" class="retire-banner">
            累计磨损已到上限，切不断、纸边起毛时就该换刀了 —— 该刀已移出可选列表。
          </div>
        </template>
        <template v-else>
          <div class="empty" style="padding: 8px">
            机器上还没有刀。先
            <button class="tiny primary" style="margin: 0 4px" @click="startRegister">登记一把刀</button>
            ，或从下方备用刀里选一把装上。
          </div>
        </template>
      </div>

      <div class="btn-row" style="margin: 12px 0">
        <button class="primary" @click="startRegister">＋ 登记新刀</button>
        <button :disabled="!mounted && available.length === 0" @click="startCut()">记一次切割（整场）</button>
        <button :disabled="!mounted" @click="startChange()">换刀登记</button>
      </div>

      <!-- 登记新刀表单 -->
      <div v-if="newForm" class="card form-card">
        <h3>登记新刀（记录上机时间与刀刃角度）</h3>
        <div class="form-grid">
          <div class="field">
            <label>刀号 / 名称</label>
            <input type="text" v-model="newForm.name" placeholder="如 45°-03" />
          </div>
          <div class="field">
            <label>刀刃角度</label>
            <select v-model.number="newForm.angleDeg">
              <option v-for="a in BLADE_ANGLES" :key="a" :value="a">{{ a }}°</option>
            </select>
          </div>
          <div class="field">
            <label>磨损上限（磨损点）</label>
            <input type="number" min="1" step="1" v-model.number="newForm.wearLimit" />
          </div>
          <div class="field">
            <label>备注</label>
            <input type="text" v-model="newForm.note" placeholder="品牌 / 刃长等（可选）" />
          </div>
        </div>
        <div class="hint">上机时间取登记当下；各纸张折算系数初始取内置默认，之后可逐纸单独调。</div>
        <div v-if="formError" class="banner err" style="margin-top: 6px">{{ formError }}</div>
        <div class="btn-row" style="margin-top: 8px">
          <button class="primary" @click="confirmRegister">登记并装机</button>
          <button @click="newForm = null">取消</button>
        </div>
      </div>

      <!-- 切割记账表单 -->
      <div v-if="cutBladeId !== null" class="card form-card">
        <h3>记一次切割（多形状 / 多图层按整场刀路总量）</h3>
        <div class="form-grid">
          <div class="field">
            <label>用刀</label>
            <select v-model="cutBladeId">
              <option v-for="b in available" :key="b.id" :value="b.id">
                {{ b.name }}（{{ b.angleDeg }}°，剩 {{ fmtNum(bladeStats(b, state.ledger.cuts).remaining) }}）
              </option>
            </select>
            <div v-if="available.length === 0" class="hint">没有可选刀具，需要先登记新刀。</div>
          </div>
          <div class="field">
            <label>纸张种类</label>
            <select v-model="cutForm.paper" @change="onCutPaperChange">
              <option v-for="p in PAPER_KINDS" :key="p.paper" :value="p.paper">{{ p.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>整场刀路长度（mm）</label>
            <input type="number" min="0" step="0.1" v-model.number="cutForm.lengthMm" />
            <div class="hint">从导出页「记一笔磨损」可自动带入本项目全场刀路长度。</div>
          </div>
          <div class="field">
            <label>重复遍数</label>
            <input type="number" min="1" max="10" step="1" v-model.number="cutForm.passes" />
          </div>
          <div class="field span2">
            <label>活名 / 备注</label>
            <input type="text" v-model="cutForm.jobName" placeholder="如 双喜窗花 2×3 排版（可选）" />
          </div>
        </div>
        <div class="hint">
          刀压 / 速度以材料预设为准并在记账时快照：当前预设
          {{ presetOfPaper(cutForm.paper)?.name ?? '—' }}
          （刀压 {{ presetOfPaper(cutForm.paper)?.force ?? '—' }}，
          {{ presetOfPaper(cutForm.paper)?.speedMmS ?? '—' }}mm/s），以后改预设不会带乱旧账。
        </div>
        <div v-if="cutBlade && cutForm.lengthMm > 0" class="preview-line">
          折算系数 {{ fmtNum(cutPreview.factor, 3) }} /m｜走刀 {{ fmtNum(cutPreview.meters, 3) }}m｜
          本笔磨损 <strong>+{{ fmtNum(cutPreview.wear) }}</strong>
          <template v-if="cutAfterStats">
            ｜记后剩 <strong :class="{ over: cutAfterStats.remaining <= 0 }">{{ fmtNum(cutAfterStats.remaining) }}</strong>
            <span v-if="cutAfterStats.remaining <= 0" class="tag err">记完即到顶</span>
          </template>
        </div>
        <div v-if="cutError" class="banner err" style="margin-top: 6px">{{ cutError }}</div>
        <div class="btn-row" style="margin-top: 8px">
          <button class="primary" @click="confirmCut">确认记账</button>
          <button @click="cutBladeId = null">取消</button>
        </div>
      </div>

      <!-- 换刀表单 -->
      <div v-if="changeOldId !== null" class="card form-card">
        <h3>换刀登记</h3>
        <div v-if="changeOld && changeOldStats" class="old-summary">
          旧刀 <strong>{{ changeOld.name }}</strong>（{{ changeOld.angleDeg }}°）卸下时：
          累计磨损 <strong>{{ fmtNum(changeOldStats.wear) }}</strong> / {{ fmtNum(changeOld.wearLimit) }}，
          共切 <strong>{{ fmtNum(changeOldStats.totalMeters) }} m</strong>，{{ changeOldStats.cutCount }} 场。
        </div>
        <div class="field-row" style="margin: 8px 0">
          <label>新刀来源</label>
          <div class="mode-switch">
            <button :class="{ active: changeMode === 'new' }" @click="changeMode = 'new'">当场登记新刀</button>
            <button :class="{ active: changeMode === 'existing' }" :disabled="spareBlades.length === 0" @click="changeMode = 'existing'">
              用备用刀（{{ spareBlades.length }}）
            </button>
          </div>
        </div>
        <div v-if="changeMode === 'new'" class="form-grid">
          <div class="field">
            <label>新刀刀号</label>
            <input type="text" v-model="changeForm.name" />
          </div>
          <div class="field">
            <label>刀刃角度</label>
            <select v-model.number="changeForm.angleDeg">
              <option v-for="a in BLADE_ANGLES" :key="a" :value="a">{{ a }}°</option>
            </select>
          </div>
          <div class="field">
            <label>磨损上限</label>
            <input type="number" min="1" step="1" v-model.number="changeForm.wearLimit" />
          </div>
          <div class="field">
            <label>备注</label>
            <input type="text" v-model="changeForm.note" />
          </div>
        </div>
        <div v-else class="field">
          <label>选择备用刀</label>
          <select v-model="changeExistingId">
            <option v-for="b in spareBlades" :key="b.id" :value="b.id">
              {{ b.name }}（{{ b.angleDeg }}°，上机 {{ fmtDateTime(b.mountedAt) }}，剩 {{ fmtNum(bladeStats(b, state.ledger.cuts).remaining) }}）
            </option>
          </select>
        </div>
        <div v-if="changeError" class="banner err" style="margin-top: 6px">{{ changeError }}</div>
        <div class="btn-row" style="margin-top: 8px">
          <button class="primary" @click="confirmChange">确认换刀并记账</button>
          <button @click="changeOldId = null">取消</button>
        </div>
      </div>

      <!-- 折算系数调整 -->
      <div v-if="factorBladeId && factorBlade()" class="card form-card">
        <h3>折算系数 · {{ factorBlade()?.name }}</h3>
        <div class="hint">
          系数 = 每米刀路产生的磨损点，只对这把刀生效。改完保存后，这把刀已经累计的磨损立即按新系数重算；
          别的刀与材料预设（刀压/速度）不受影响。
        </div>
        <table class="grid" style="margin-top: 6px">
          <thead>
            <tr><th>纸张</th><th style="width: 150px">系数（磨损点 / 米）</th><th>这张纸已切</th></tr>
          </thead>
          <tbody>
            <tr v-for="key in factorPapers" :key="key">
              <td>{{ paperText(key) }}</td>
              <td class="num">
                <input type="number" min="0" step="0.05" v-model.number="factorDraft[key]" />
              </td>
              <td class="num">{{ fmtNum((factorRow?.metersByPaper[key] ?? 0), 3) }} m</td>
            </tr>
          </tbody>
        </table>
        <div class="btn-row" style="margin-top: 8px">
          <button class="primary" @click="saveFactors">保存并重算</button>
          <button @click="factorBladeId = null">取消</button>
        </div>
      </div>

      <!-- 在役刀具 -->
      <h2 class="sec">在役 / 备用刀具（{{ activeRows.length }}）</h2>
      <div v-if="activeRows.length === 0" class="empty">还没有在役刀具。</div>
      <table v-else class="grid blade-table">
        <thead>
          <tr>
            <th>刀号</th>
            <th>角度</th>
            <th>上机时间</th>
            <th style="width: 200px">剩余寿命</th>
            <th>累计磨损</th>
            <th>总切割</th>
            <th>场次</th>
            <th>最近换过</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in activeRows" :key="r.blade.id" :class="{ sel: mounted?.id === r.blade.id }">
            <td>
              <strong>{{ r.blade.name }}</strong>
              <span v-if="mounted?.id === r.blade.id" class="tag accent" style="margin-left: 4px">装机中</span>
            </td>
            <td class="num">{{ r.blade.angleDeg }}°</td>
            <td class="mono">{{ fmtDateTime(r.blade.mountedAt) }}</td>
            <td>
              <div class="bar-track sm">
                <div :class="barClass(r)" :style="{ width: r.stats.remainingPct + '%' }"></div>
              </div>
              <div class="hint">{{ fmtNum(r.stats.remaining) }} / {{ fmtNum(r.blade.wearLimit) }}</div>
            </td>
            <td class="num">{{ fmtNum(r.stats.wear) }}</td>
            <td class="num">{{ fmtNum(r.stats.totalMeters) }} m</td>
            <td class="num">{{ r.stats.cutCount }}</td>
            <td class="num">{{ r.changes }} 次</td>
            <td>
              <div class="btn-row">
                <button class="tiny" @click="startCut(r.blade)">记账</button>
                <button class="tiny" @click="startChange(r.blade)">换刀</button>
                <button class="tiny" @click="startFactors(r.blade)">系数</button>
                <button class="tiny" @click="startEdit(r.blade)">编辑</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 编辑刀档 -->
      <div v-if="editingId && editForm" class="card form-card" style="margin-top: 10px">
        <h3>编辑刀档</h3>
        <div class="form-grid">
          <div class="field">
            <label>刀号</label>
            <input type="text" v-model="editForm.name" />
          </div>
          <div class="field">
            <label>刀刃角度</label>
            <input type="number" min="10" max="90" step="1" v-model.number="editForm.angleDeg" />
          </div>
          <div class="field">
            <label>磨损上限</label>
            <input type="number" min="1" step="1" v-model.number="editForm.wearLimit" />
          </div>
          <div class="field">
            <label>备注</label>
            <input type="text" v-model="editForm.note" />
          </div>
        </div>
        <div class="btn-row" style="margin-top: 8px">
          <button class="primary" @click="saveEdit">保存并重算</button>
          <button @click="editingId = null">取消</button>
        </div>
      </div>

      <!-- 最近换刀 -->
      <h2 class="sec">最近换刀（{{ changes.length }}）</h2>
      <div v-if="changes.length === 0" class="empty">还没有换过刀。</div>
      <table v-else class="grid">
        <thead>
          <tr>
            <th>时间</th>
            <th>旧刀</th>
            <th>卸下时磨损</th>
            <th>累计切割</th>
            <th>原因</th>
            <th>换上的新刀</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in changes" :key="c.id">
            <td class="mono">{{ fmtDateTime(c.at) }}</td>
            <td>{{ c.bladeName }}</td>
            <td class="num">{{ fmtNum(c.wearAtRetire) }} / {{ fmtNum(c.wearLimit) }}</td>
            <td class="num">{{ fmtNum(c.totalMetersAtRetire) }} m</td>
            <td>
              <span class="tag" :class="c.reason === 'limit' ? 'err' : 'warn'">{{ reasonText(c.reason) }}</span>
            </td>
            <td>{{ c.newBladeName }}</td>
            <td>{{ c.note ?? '' }}</td>
          </tr>
        </tbody>
      </table>

      <!-- 已换下的刀 -->
      <template v-if="retiredRows.length > 0">
        <h2 class="sec">已换下的刀（{{ retiredRows.length }}）</h2>
        <table class="grid blade-table">
          <thead>
            <tr>
              <th>刀号</th>
              <th>角度</th>
              <th>上机时间</th>
              <th>累计磨损</th>
              <th>总切割</th>
              <th>换下原因</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in retiredRows" :key="r.blade.id" class="retired">
              <td><strong>{{ r.blade.name }}</strong></td>
              <td class="num">{{ r.blade.angleDeg }}°</td>
              <td class="mono">{{ fmtDateTime(r.blade.mountedAt) }}</td>
              <td class="num">{{ fmtNum(r.stats.wear) }} / {{ fmtNum(r.blade.wearLimit) }}</td>
              <td class="num">{{ fmtNum(r.stats.totalMeters) }} m</td>
              <td><span class="tag">{{ reasonText(r.blade.retireReason ?? 'manual') }}</span></td>
              <td>
                <div class="btn-row">
                  <button class="tiny" @click="startFactors(r.blade)">调系数</button>
                  <button v-if="r.stats.cutCount === 0" class="tiny danger" @click="removeIdleBlade(r.blade)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="hint">调小折算系数或删除磨损流水后，因到顶自动换下的刀若重新回到上限内，会自动回到可选列表。</div>
      </template>

      <!-- 最近切割流水 -->
      <h2 class="sec">最近切割流水（{{ state.ledger.cuts.length }} 场）</h2>
      <div v-if="recentCuts.length === 0" class="empty">还没有切割记录。</div>
      <table v-else class="grid">
        <thead>
          <tr>
            <th>时间</th>
            <th>刀具</th>
            <th>纸张</th>
            <th>刀路长度</th>
            <th>遍数</th>
            <th>折算磨损</th>
            <th>刀压/速度快照</th>
            <th>活名</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in recentCuts" :key="c.id">
            <td class="mono">{{ fmtDateTime(c.at) }}</td>
            <td>{{ bladeName(c.bladeId) }}</td>
            <td>{{ paperText(c.paper) }}</td>
            <td class="num">{{ fmtNum(c.lengthMm) }} mm</td>
            <td class="num">{{ c.passes }}</td>
            <td class="num">{{ fmtNum(cutWear(c)) }}</td>
            <td class="num mono">{{ c.force }} / {{ c.speedMmS }}mm·s⁻¹</td>
            <td>{{ c.jobName ?? '' }}</td>
            <td><button class="tiny danger" @click="removeCut(c)">删</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.banner {
  padding: 7px 10px;
  border-radius: 6px;
  margin: 8px 0;
  font-size: 12.5px;
}
.banner.ok {
  background: rgba(71, 192, 122, 0.12);
  border: 1px solid rgba(71, 192, 122, 0.35);
  color: #9fe0b8;
}
.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
}

.sec {
  margin: 18px 0 8px;
}

.mounted-card {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto auto;
  gap: 14px;
  align-items: center;
  margin-top: 10px;
}

.mounted-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.mounted-title strong {
  font-size: 15px;
}

.life-line {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mounted-meta {
  display: flex;
  gap: 6px;
}

.mounted-actions {
  display: flex;
  flex-direction: column;
  gap: 5px;
  align-items: stretch;
}

.retire-banner {
  grid-column: 1 / -1;
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
}

.bar-track {
  height: 10px;
  background: var(--bg-grid);
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
}

.bar-track.sm {
  height: 8px;
}

.bar {
  height: 100%;
  border-radius: 5px;
  transition: width 0.25s ease;
}

.bar.ok {
  background: var(--ok);
}

.bar.warn {
  background: var(--warn);
}

.bar.err {
  background: var(--err);
}

.life-nums {
  font-size: 11.5px;
  color: var(--text-dim);
}

.life-nums strong {
  font-family: var(--mono);
  color: var(--text);
}

.form-card {
  margin: 10px 0;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}

.form-grid .span2 {
  grid-column: span 2;
}

.preview-line {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--panel-2);
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  padding: 6px 9px;
}

.preview-line strong {
  color: var(--accent-2);
  font-family: var(--mono);
}

.over {
  color: var(--err);
}

.old-summary {
  background: var(--panel-2);
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  padding: 7px 10px;
  font-size: 12.5px;
}

.old-summary strong {
  font-family: var(--mono);
  color: var(--accent-2);
}

.blade-table .bar-track {
  min-width: 120px;
}

tr.retired {
  opacity: 0.72;
}

tr.retired strong {
  text-decoration: line-through;
  text-decoration-color: var(--text-mute);
}
</style>
