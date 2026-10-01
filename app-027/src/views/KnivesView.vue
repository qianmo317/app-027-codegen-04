<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  DEFAULT_PAPER_FACTORS,
  DEFAULT_WEAR_LIMIT,
  currentKnife,
  factorOf,
  knifeActions,
  ledger,
  recentReplacements,
  statsOf,
  type Knife,
  type KnifeReplacement,
} from '@/logic/knives'
import { PAPER_KINDS } from '@/logic/types'

const allPapers = PAPER_KINDS.map((p) => ({ paper: p.paper, label: p.label, note: p.note }))
const customPapers = computed(() => {
  const known = new Set(PAPER_KINDS.map((p) => p.paper))
  const extra = new Set<string>()
  for (const r of ledger.records) if (!known.has(r.paper)) extra.add(r.paper)
  return Array.from(extra).map((paper) => ({ paper, label: paper, note: '自定义纸张' }))
})
const paperRows = computed(() => [...allPapers, ...customPapers.value])

const paperLabel = (paper: string): string => allPapers.find((p) => p.paper === paper)?.label ?? paper

// ---------------- 登记新刀 ----------------
const today = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const showRegister = ref(false)
const regForm = ref({ name: '', edgeAngleDeg: 45, wearLimit: DEFAULT_WEAR_LIMIT, mountedAt: today(), note: '' })

function openRegister(): void {
  regForm.value = { name: '', edgeAngleDeg: 45, wearLimit: current.value?.wearLimit ?? DEFAULT_WEAR_LIMIT, mountedAt: today(), note: '' }
  showRegister.value = true
}

function submitRegister(): void {
  const t = new Date(regForm.value.mountedAt).getTime()
  knifeActions.register({
    name: regForm.value.name,
    edgeAngleDeg: regForm.value.edgeAngleDeg,
    wearLimit: regForm.value.wearLimit,
    mountedAt: Number.isFinite(t) ? t : Date.now(),
    note: regForm.value.note,
  })
  showRegister.value = false
}

// ---------------- 派生列表 ----------------
const current = computed(() => currentKnife(ledger))
const recent = computed(() => recentReplacements(ledger, 5))

/** 列表分组：在用 / 备用 / 该换 / 已退役 */
const groupedKnives = computed(() => {
  const groups: Array<{ key: string; title: string; knives: Knife[] }> = [
    { key: 'in_use', title: '正在使用', knives: [] },
    { key: 'spare', title: '备用刀', knives: [] },
    { key: 'due', title: '该换刀（已到寿，已移出可选列表）', knives: [] },
    { key: 'retired', title: '已退役（换刀卸下）', knives: [] },
  ]
  for (const k of ledger.knives) groups.find((g) => g.key === k.status)?.knives.push(k)
  for (const g of groups) g.knives.sort((a, b) => b.mountedAt - a.mountedAt)
  return groups.filter((g) => g.knives.length > 0)
})

const statsCache = computed(() => {
  // 依赖 records / factors 变化自动重算
  void ledger.records.length
  void ledger.factors
  const m = new Map<string, ReturnType<typeof statsOf>>()
  for (const k of ledger.knives) m.set(k.id, statsOf(ledger, k.id))
  return m
})
const stats = (id: string) => statsCache.value.get(id)!

// ---------------- 换刀 ----------------
const replaceTarget = ref<Knife | null>(null)
const replaceForm = ref({ newKnifeId: '', registerAndMount: false, name: '', edgeAngleDeg: 45, note: '' })

const replaceCandidates = computed(() => {
  if (!replaceTarget.value) return []
  return ledger.knives.filter((k) => k.id !== replaceTarget.value!.id && k.status === 'spare')
})

function openReplace(k: Knife): void {
  replaceTarget.value = k
  replaceForm.value = {
    newKnifeId: replaceCandidates.value[0]?.id ?? '',
    registerAndMount: replaceCandidates.value.length === 0,
    name: `新刀 ${ledger.knives.length + 1}#`,
    edgeAngleDeg: k.edgeAngleDeg,
    note: '',
  }
}

function confirmReplace(): void {
  const old = replaceTarget.value
  if (!old) return
  let newId = replaceForm.value.newKnifeId
  if (replaceForm.value.registerAndMount) {
    const k = knifeActions.register({
      name: replaceForm.value.name,
      edgeAngleDeg: replaceForm.value.edgeAngleDeg,
      wearLimit: old.wearLimit,
      note: '',
    })
    newId = k.id
  }
  if (!newId) return
  knifeActions.replace(old.id, newId, { note: replaceForm.value.note })
  replaceTarget.value = null
}

function makeCurrent(k: Knife): void {
  if (current.value && !confirm(`把在用刀「${current.value.name}」换为备用，改用「${k.name}」？不记换刀账。`)) return
  knifeActions.setCurrent(k.id)
}

function removeKnife(k: Knife): void {
  if (!confirm(`删除刀具「${k.name}」？它的 ${stats(k.id).cuts} 笔切割账会一并删除（换刀历史保留）。`)) return
  knifeActions.remove(k.id)
}

// ---------------- 信息 / 系数编辑 ----------------
const editingInfo = ref<Knife | null>(null)
const infoForm = ref({ name: '', edgeAngleDeg: 45, wearLimit: DEFAULT_WEAR_LIMIT, note: '' })
function startEditInfo(k: Knife): void {
  editingInfo.value = k
  infoForm.value = { name: k.name, edgeAngleDeg: k.edgeAngleDeg, wearLimit: k.wearLimit, note: k.note }
}
function saveInfo(): void {
  if (!editingInfo.value) return
  knifeActions.updateInfo(editingInfo.value.id, { ...infoForm.value })
  editingInfo.value = null
}

const factorKnife = ref<Knife | null>(null)
const factorDraft = ref<Record<string, string>>({})
function startEditFactors(k: Knife): void {
  factorKnife.value = k
  const draft: Record<string, string> = {}
  for (const p of paperRows.value) draft[p.paper] = String(factorOf(ledger, k.id, p.paper))
  factorDraft.value = draft
}
function saveFactors(): void {
  if (!factorKnife.value) return
  for (const p of paperRows.value) {
    const v = Number(factorDraft.value[p.paper])
    if (Number.isFinite(v) && v >= 0) knifeActions.setFactor(factorKnife.value.id, p.paper, v)
  }
  factorKnife.value = null
}
function resetOneFactor(paper: string): void {
  if (!factorKnife.value) return
  knifeActions.resetFactor(factorKnife.value.id, paper)
  factorDraft.value[paper] = String(factorOf(ledger, factorKnife.value.id, paper))
}
const isFactorCustom = (kId: string, paper: string) => ledger.factors[kId]?.[paper] !== undefined

// ---------------- 切割明细 ----------------
const detailKnife = ref<Knife | null>(null)
const detailRecords = computed(() =>
  detailKnife.value
    ? ledger.records
        .filter((r) => r.knifeId === detailKnife.value!.id)
        .sort((a, b) => b.at - a.at)
    : [],
)

function removeRecord(id: string): void {
  if (!confirm('删除这笔切割账？累计磨损会自动回落重算。')) return
  knifeActions.removeCut(id)
}

// ---------------- 展示辅助 ----------------
const fmt = (n: number, d = 1) => n.toFixed(d)
const fmtDate = (t: number) => {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function barColor(ratio: number): string {
  if (ratio >= 1) return 'var(--err)'
  if (ratio >= 0.8) return 'var(--warn)'
  return 'var(--ok)'
}

const statusTag: Record<Knife['status'], { text: string; cls: string }> = {
  in_use: { text: '在用', cls: 'accent' },
  spare: { text: '备用', cls: 'info' },
  due: { text: '该换刀', cls: 'err' },
  retired: { text: '已退役', cls: '' },
}

function repOldWear(r: KnifeReplacement): number {
  return r.oldWear
}
</script>

<template>
  <div class="page">
    <div class="page narrow">
      <h1>刀具台账</h1>
      <p class="hint">
        每把刀登记上机时间与刀刃角度；每完成一场切割按「实际刀路总长 × 重复遍数 × 纸张折算系数」累加磨损。
        多形状、多图层的活按整场总量记一笔。累计到上限即提示换刀并自动移出可选列表。
      </p>

      <!-- 概览 -->
      <div class="stat-grid overview">
        <div class="stat">
          <div class="k">当前在用</div>
          <div class="v">{{ current ? current.name : '—' }}</div>
          <div v-if="current" class="hint">
            {{ current.edgeAngleDeg }}°｜剩余寿命 {{ fmt(stats(current.id).remaining) }} 折算米
          </div>
        </div>
        <div class="stat">
          <div class="k">备用刀</div>
          <div class="v">{{ ledger.knives.filter((k) => k.status === 'spare').length }}<small>把</small></div>
        </div>
        <div class="stat">
          <div class="k">该换刀</div>
          <div class="v" :style="{ color: ledger.knives.some((k) => k.status === 'due') ? 'var(--err)' : '' }">
            {{ ledger.knives.filter((k) => k.status === 'due').length }}<small>把</small>
          </div>
        </div>
        <div class="stat">
          <div class="k">累计换刀</div>
          <div class="v">{{ ledger.replacements.length }}<small>次</small></div>
          <div v-if="recent.length" class="hint">最近 {{ recent.length }} 次见下方台账</div>
        </div>
      </div>

      <div class="btn-row" style="margin: 10px 0">
        <button class="primary" @click="openRegister">＋ 登记新刀（上机）</button>
        <RouterLink class="btn ghost" to="/materials">材料预设（刀压/速度以预设为准）</RouterLink>
      </div>

      <!-- 登记表单 -->
      <div v-if="showRegister" class="card form-card">
        <h3>登记刀具</h3>
        <div class="edit-grid">
          <div class="field">
            <label>刀号 / 名称</label>
            <input type="text" v-model="regForm.name" placeholder="如：3# 45° 硬质合金刻刀" />
          </div>
          <div class="field">
            <label>刀刃角度（度）</label>
            <input type="number" min="15" max="90" step="1" v-model.number="regForm.edgeAngleDeg" />
          </div>
          <div class="field">
            <label>磨损上限（折算米）</label>
            <input type="number" min="10" step="10" v-model.number="regForm.wearLimit" />
          </div>
          <div class="field">
            <label>上机时间</label>
            <input type="datetime-local" v-model="regForm.mountedAt" />
          </div>
          <div class="field wide">
            <label>备注</label>
            <input type="text" v-model="regForm.note" placeholder="品牌 / 装刀伸出量 / 适用纸张（可选）" />
          </div>
        </div>
        <div class="hint">
          当前{{ current ? '已有在用刀，新刀登记为备用，换刀时上机' : '没有在用刀，登记后直接上机' }}。
        </div>
        <div class="btn-row" style="margin-top: 8px">
          <button class="primary" @click="submitRegister">登记</button>
          <button @click="showRegister = false">取消</button>
        </div>
      </div>

      <!-- 该换刀横幅 -->
      <div v-for="k in ledger.knives.filter((x) => x.status === 'due')" :key="'due-' + k.id" class="banner due">
        <strong>该换刀了：{{ k.name }}（{{ k.edgeAngleDeg }}°）</strong>
        累计磨损 {{ fmt(stats(k.id).wear) }} / {{ k.wearLimit }} 折算米，共切 {{ fmt(stats(k.id).rawMeters) }} 米，
        已从可选刀列表移出。
        <button class="tiny primary" @click="openReplace(k)">立即换刀</button>
      </div>

      <!-- 刀具列表 -->
      <div v-if="ledger.knives.length === 0" class="card empty-card">
        还没有登记刀具。点「登记新刀（上机）」开始建账：记下上机时间、刀刃角度与磨损上限，之后每切一场记一笔。
      </div>

      <div v-for="g in groupedKnives" :key="g.key" class="group">
        <h2 class="group-title">{{ g.title }}</h2>
        <div class="card-grid knife-grid">
          <div v-for="k in g.knives" :key="k.id" class="card knife-card" :class="{ current: k.status === 'in_use', due: k.status === 'due' }">
            <div class="knife-head">
              <strong>{{ k.name }}</strong>
              <span class="tag" :class="statusTag[k.status].cls">{{ statusTag[k.status].text }}</span>
            </div>
            <div class="knife-meta">
              <span><i>角度</i>{{ k.edgeAngleDeg }}°</span>
              <span><i>上机</i>{{ fmtDate(k.mountedAt).slice(0, 10) }}</span>
              <span v-if="k.retiredAt"><i>卸下</i>{{ fmtDate(k.retiredAt).slice(0, 10) }}</span>
            </div>

            <div class="life">
              <div class="life-bar">
                <div class="life-fill" :style="{ width: Math.min(100, stats(k.id).usedRatio * 100) + '%', background: barColor(stats(k.id).usedRatio) }"></div>
              </div>
              <div class="life-num">
                已磨损 <b :style="{ color: barColor(stats(k.id).usedRatio) }">{{ fmt(stats(k.id).wear) }}</b> / {{ k.wearLimit }}
                折算米｜剩余 <b>{{ fmt(stats(k.id).remaining) }}</b> 折算米（{{ (Math.max(0, 1 - stats(k.id).usedRatio) * 100).toFixed(0) }}%）
              </div>
            </div>

            <table class="grid mini">
              <tbody>
                <tr><th>实际切割</th><td class="num">{{ fmt(stats(k.id).rawMeters) }} m</td><th>计遍数刀路</th><td class="num">{{ fmt(stats(k.id).passMeters) }} m</td></tr>
                <tr><th>切割场次</th><td class="num">{{ stats(k.id).cuts }}</td><th>磨损上限</th><td class="num">{{ k.wearLimit }}</td></tr>
              </tbody>
            </table>

            <div class="paper-chips">
              <span v-for="(w, paper) in stats(k.id).wearByPaper" :key="paper" class="chip" :title="`折算磨损 ${fmt(w)}`">
                {{ paperLabel(paper) }} {{ fmt((stats(k.id).metersByPaper[paper] ?? 0)) }}m
                <i :class="{ custom: isFactorCustom(k.id, paper) }">×{{ factorOf(ledger, k.id, paper) }}</i>
              </span>
            </div>
            <div v-if="k.note" class="hint note-line">{{ k.note }}</div>

            <div class="btn-row">
              <button v-if="k.status === 'due'" class="tiny primary" @click="openReplace(k)">换刀</button>
              <button v-if="k.status === 'spare'" class="tiny" @click="makeCurrent(k)">设为在用</button>
              <button class="tiny" @click="startEditInfo(k)">资料</button>
              <button class="tiny" @click="startEditFactors(k)">折算系数</button>
              <button class="tiny" @click="detailKnife = k">切割明细</button>
              <button class="tiny danger" @click="removeKnife(k)">删除</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 换刀记录 -->
      <div class="section ledger-section">
        <h2>换刀记录</h2>
        <div v-if="ledger.replacements.length === 0" class="empty">暂无换刀记录。</div>
        <table v-else class="grid">
          <thead>
            <tr><th>时间</th><th>旧刀卸下</th><th>累计磨损</th><th>共切</th><th>换上新刀</th><th>备注</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in [...ledger.replacements].reverse()" :key="r.id">
              <td class="mono">{{ fmtDate(r.at) }}</td>
              <td>{{ r.oldKnifeName }}</td>
              <td class="num">{{ fmt(repOldWear(r)) }} 折算米</td>
              <td class="num">{{ fmt(r.oldRawMeters) }} m</td>
              <td>{{ r.newKnifeName }}</td>
              <td class="dim">{{ r.note ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 折算系数说明 -->
      <div class="section">
        <h2>折算系数怎么定</h2>
        <table class="grid">
          <thead>
            <tr><th>纸张</th><th>默认系数</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in allPapers" :key="p.paper">
              <td>{{ p.label }}</td>
              <td class="num">{{ DEFAULT_PAPER_FACTORS[p.paper] ?? 1 }}</td>
              <td class="dim">{{ p.note }}</td>
            </tr>
          </tbody>
        </table>
        <div class="hint">
          磨损 = 整场刀路长度（米）× 重复遍数 × 系数。植绒纤维阻力大系数高，宣纸轻切系数低。
          每把刀可在卡片「折算系数」里按纸张单独调整；调完后该刀已累计的磨损立即按新系数重算，
          历史记录只保留当时的实际刀路长度、纸张与遍数快照，<b>改材料预设的刀压/速度不会影响已记的账</b>。
        </div>
      </div>
    </div>

    <!-- 换刀弹层 -->
    <div v-if="replaceTarget" class="modal-mask" @click.self="replaceTarget = null">
      <div class="modal card">
        <h3>换刀：{{ replaceTarget.name }}</h3>
        <div class="hint" style="margin-bottom: 8px">
          卸下时累计磨损 <b>{{ fmt(stats(replaceTarget.id).wear) }}</b> / {{ replaceTarget.wearLimit }} 折算米，
          一共实际切了 <b>{{ fmt(stats(replaceTarget.id).rawMeters) }}</b> 米，{{ stats(replaceTarget.id).cuts }} 场。
        </div>
        <label class="check"><input type="checkbox" v-model="replaceForm.registerAndMount" :disabled="replaceCandidates.length === 0" /> 换一把新刀（现场登记并上机）</label>
        <div v-if="!replaceForm.registerAndMount" class="field">
          <label>选择备用刀上机</label>
          <select v-model="replaceForm.newKnifeId">
            <option v-for="k in replaceCandidates" :key="k.id" :value="k.id">
              {{ k.name }}（{{ k.edgeAngleDeg }}°，剩 {{ fmt(stats(k.id).remaining) }} 折算米）
            </option>
          </select>
          <div v-if="replaceCandidates.length === 0" class="hint">没有备用刀，请勾选「换一把新刀」。</div>
        </div>
        <template v-else>
          <div class="field-row">
            <label>新刀名称</label>
            <input type="text" v-model="replaceForm.name" />
          </div>
          <div class="field-row">
            <label>刀刃角度</label>
            <input type="number" min="15" max="90" v-model.number="replaceForm.edgeAngleDeg" />
          </div>
        </template>
        <div class="field" style="margin-top: 6px">
          <label>换刀备注（可选）</label>
          <input type="text" v-model="replaceForm.note" placeholder="如：刀尖崩口 / 纸边起毛更换" />
        </div>
        <div class="btn-row">
          <button class="primary" :disabled="!replaceForm.registerAndMount && !replaceForm.newKnifeId" @click="confirmReplace">确认换刀并记账</button>
          <button @click="replaceTarget = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 资料编辑弹层 -->
    <div v-if="editingInfo" class="modal-mask" @click.self="editingInfo = null">
      <div class="modal card">
        <h3>刀具资料</h3>
        <div class="field"><label>刀号 / 名称</label><input type="text" v-model="infoForm.name" /></div>
        <div class="field-row">
          <div class="field" style="flex: 1"><label>刀刃角度（度）</label><input type="number" min="15" max="90" v-model.number="infoForm.edgeAngleDeg" /></div>
          <div class="field" style="flex: 1"><label>磨损上限（折算米）</label><input type="number" min="10" v-model.number="infoForm.wearLimit" /></div>
        </div>
        <div class="field"><label>备注</label><input type="text" v-model="infoForm.note" /></div>
        <div class="hint">改磨损上限后，「该换刀」判定立即按新上限重新计算（已记磨损不变）。</div>
        <div class="btn-row" style="margin-top: 8px">
          <button class="primary" @click="saveInfo">保存</button>
          <button @click="editingInfo = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 系数编辑弹层 -->
    <div v-if="factorKnife" class="modal-mask" @click.self="factorKnife = null">
      <div class="modal card wide-modal">
        <h3>{{ factorKnife.name }} · 纸张折算系数</h3>
        <table class="grid">
          <thead>
            <tr><th>纸张</th><th>系数（磨损分/米·遍）</th><th>该纸已切</th><th>该纸磨损</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="p in paperRows" :key="p.paper">
              <td>{{ p.label }}</td>
              <td class="num"><input type="number" min="0" step="0.1" v-model="factorDraft[p.paper]" style="width: 90px" /></td>
              <td class="num">{{ fmt(stats(factorKnife.id).metersByPaper[p.paper] ?? 0) }} m</td>
              <td class="num">{{ fmt(stats(factorKnife.id).wearByPaper[p.paper] ?? 0) }}</td>
              <td>
                <button v-if="isFactorCustom(factorKnife.id, p.paper)" class="tiny" @click="resetOneFactor(p.paper)">恢复默认 {{ DEFAULT_PAPER_FACTORS[p.paper] ?? 1 }}</button>
                <span v-else class="dim">默认</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="hint">保存后，这把刀在该纸张上的全部历史账按新系数重算（其它纸张不动）；若因此到寿或回到寿命内，状态会自动更新。</div>
        <div class="btn-row" style="margin-top: 8px">
          <button class="primary" @click="saveFactors">保存并重算</button>
          <button @click="factorKnife = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 切割明细弹层 -->
    <div v-if="detailKnife" class="modal-mask" @click.self="detailKnife = null">
      <div class="modal card wide-modal">
        <h3>{{ detailKnife.name }} · 切割明细</h3>
        <div v-if="detailRecords.length === 0" class="empty">这把刀还没有切割记录。</div>
        <table v-else class="grid">
          <thead>
            <tr><th>时间</th><th>活名</th><th>纸张</th><th>刀路</th><th>遍数</th><th>系数</th><th>磨损</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="r in detailRecords" :key="r.id">
              <td class="mono">{{ fmtDate(r.at) }}</td>
              <td>{{ r.projectName }}</td>
              <td>{{ r.paperLabel }}</td>
              <td class="num">{{ fmt(r.cutLengthMm / 1000, 3) }} m</td>
              <td class="num">{{ r.passes }}</td>
              <td class="num">×{{ factorOf(ledger, r.knifeId, r.paper) }}</td>
              <td class="num">{{ fmt((r.cutLengthMm / 1000) * r.passes * factorOf(ledger, r.knifeId, r.paper), 3) }}</td>
              <td><button class="tiny danger" @click="removeRecord(r.id)">删</button></td>
            </tr>
          </tbody>
        </table>
        <div class="hint">「系数」列显示当前生效值；调过折算系数后，旧账的磨损也按新值显示。删除某笔后累计磨损自动回落。</div>
        <div class="btn-row" style="margin-top: 8px">
          <button @click="detailKnife = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overview {
  margin-top: 10px;
}

.group {
  margin-top: 14px;
}

.group-title {
  font-size: 13px;
  color: var(--text-dim);
  margin: 0 0 8px;
}

.knife-grid {
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
}

.knife-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}

.knife-card.current {
  border-color: rgba(255, 143, 60, 0.55);
  box-shadow: 0 0 0 1px rgba(255, 143, 60, 0.25);
}

.knife-card.due {
  border-color: rgba(255, 107, 107, 0.55);
}

.knife-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.knife-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.knife-meta i {
  font-style: normal;
  color: var(--text-mute);
  margin-right: 3px;
}

.life-bar {
  height: 9px;
  border-radius: 5px;
  background: var(--bg-grid);
  border: 1px solid var(--line-soft);
  overflow: hidden;
}

.life-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.25s ease, background 0.25s;
}

.life-num {
  font-size: 11px;
  color: var(--text-mute);
  margin-top: 2px;
}

.life-num b {
  color: var(--text);
  font-family: var(--mono);
  font-weight: 600;
}

table.grid.mini th {
  width: auto;
  padding: 1px 4px;
}

table.grid.mini td {
  padding: 1px 4px;
}

.paper-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip {
  font-size: 10.5px;
  border: 1px solid var(--line-soft);
  background: var(--panel-2);
  border-radius: 9px;
  padding: 1px 7px;
  color: var(--text-dim);
}

.chip i {
  font-style: normal;
  color: var(--text-mute);
  margin-left: 2px;
}

.chip i.custom {
  color: var(--accent-2);
}

.note-line {
  margin-top: 0;
}

.banner.due {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.45);
  color: #ffb3b3;
  padding: 9px 12px;
  border-radius: 6px;
  margin: 10px 0;
  font-size: 12.5px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.empty-card {
  text-align: center;
  color: var(--text-mute);
  padding: 22px;
}

.form-card {
  margin: 8px 0 14px;
}

.edit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}

.edit-grid .field.wide {
  grid-column: 1 / -1;
}

.ledger-section {
  margin-top: 18px;
}

.dim {
  color: var(--text-mute);
}

.section {
  margin-top: 18px;
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(8, 11, 15, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 16px;
}

.modal {
  width: min(460px, 100%);
  max-height: 86vh;
  overflow: auto;
  background: var(--panel);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}

.modal.wide-modal {
  width: min(720px, 100%);
}

.field-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.field-row > label {
  flex: 0 0 72px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-dim);
  margin: 6px 0;
}

.group .card-grid {
  margin: 0;
}
</style>
