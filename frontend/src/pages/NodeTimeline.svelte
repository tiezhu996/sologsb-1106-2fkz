<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from 'svelte/store'
  import { link, params } from 'svelte-spa-router'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import StageRail from '../components/common/StageRail.svelte'
  import { blockStore } from '../stores/blockStore'
  import { draftStore } from '../stores/draftStore'
  import { db } from '../utils/db'
  import type { NodeStatus, ProcessNode, ProcessStage } from '../types/node'

  const stages: ProcessStage[] = ['起稿', '勾描', '上样', '刻版', '修版', '调色', '套印', '晾晒']
  const blockId = $derived($params?.id ?? '')
  const block = $derived($blockStore.find((item) => item.id === blockId) ?? null)

  let nodes = $state<ProcessNode[]>([])
  let operator = $state('')
  let durationMin = $state(60)
  let note = $state('')
  let voidOperator = $state('')
  let voidReason = $state('')
  let feedback = $state('')

  const validNodes = $derived(nodes.filter((node) => node.status !== '已作废'))
  const voidedNodes = $derived(nodes.filter((node) => node.status === '已作废'))

  function sortBySeq(list: ProcessNode[]): ProcessNode[] {
    return [...list].sort((a, b) => a.seq - b.seq)
  }

  function latestValidNode(): ProcessNode | null {
    const sorted = sortBySeq(validNodes)
    return sorted[sorted.length - 1] ?? null
  }

  const activeIndex = $derived.by(() => {
    const latest = latestValidNode()
    return latest ? stages.indexOf(latest.stage) : 0
  })

  const nextStage = $derived(
    stages.find((stage) => !validNodes.some((node) => node.stage === stage)) ?? null,
  )

  onMount(() => {
    void Promise.all([blockStore.load(), loadNodes()])
  })

  $effect(() => {
    if (block && !operator) operator = block.carvedBy
  })

  $effect(() => {
    if (block && !voidOperator) voidOperator = block.carvedBy
  })

  async function loadNodes(): Promise<void> {
    const records = await db.nodes.where('blockId').equals(blockId).toArray()
    records.sort((a, b) => a.seq - b.seq)
    nodes = records
    const validRecords = records.filter((node) => node.status !== '已作废')
    const lastValid = validRecords.length > 0 ? validRecords[validRecords.length - 1] : undefined
    if (lastValid) durationMin = lastValid.durationMin
  }

  /** 回退后按版片刻制阶段重算版片与画稿状态：已刻成退回到在刻，已修版按回退深度回落。 */
  async function syncBlockAfterVoid(voided: ProcessNode[]): Promise<void> {
    const current = get(blockStore).find((item) => item.id === blockId)
    if (!current) return
    const deepestIndex = Math.min(...voided.map((node) => stages.indexOf(node.stage)))
    const carvingIndex = stages.indexOf('刻版')

    let nextState = current.state
    if (current.state === '已刻成') {
      nextState = '在刻'
    } else if (current.state === '已修版') {
      if (deepestIndex <= carvingIndex) nextState = '在刻'
      else nextState = '已刻成'
    }

    if (nextState !== current.state) {
      await blockStore.update(current.id, { state: nextState })
      if (nextState === '在刻') {
        const siblings = get(blockStore).filter((item) => item.draftId === current.draftId)
        const allCarved = siblings.every((item) => item.state === '已刻成' || item.state === '已修版')
        await draftStore.update(current.draftId, { status: allCarved ? '可印' : '刻版中' })
      }
    }
  }

  /** 作废原因与回退操作人必须同时登记，否则不允许回退。 */
  function validateVoidForm(): boolean {
    if (!voidOperator.trim()) {
      feedback = '请先填写回退操作人。'
      return false
    }
    if (!voidReason.trim()) {
      feedback = '请填写作废原因，返工经过需要留档。'
      return false
    }
    return true
  }

  async function voidNodes(targets: ProcessNode[]): Promise<void> {
    const stampedAt = new Date().toISOString().slice(0, 16)
    const by = voidOperator.trim()
    const reason = voidReason.trim()
    await db.transaction('rw', db.nodes, db.blocks, db.drafts, async () => {
      for (const target of targets) {
        await db.nodes.update(target.id, {
          status: '已作废' satisfies NodeStatus,
          voidReason: reason,
          voidedBy: by,
          voidedAt: stampedAt,
        })
      }
    })
    await syncBlockAfterVoid(targets)
  }

  async function advanceNode(): Promise<void> {
    if (!nextStage || !block) return
    if (!operator.trim()) {
      feedback = '请先填写操作人。'
      return
    }

    const overflow = stages.indexOf(nextStage) + 1 < validNodes.length
    if (overflow) {
      feedback = '有效节点顺序与阶段轨道不一致，请先回退重排。'
      return
    }

    // 重新推进一律生成新节点：旧节点保留作废记录，不复活、不复用序号。
    const nextSeq = Math.max(0, ...nodes.map((node) => node.seq)) + 1
    await db.nodes.add({
      id: `node-${crypto.randomUUID()}`,
      blockId: block.id,
      stage: nextStage,
      seq: nextSeq,
      operator: operator.trim(),
      startedAt: new Date().toISOString().slice(0, 16),
      durationMin: Math.max(0, Number(durationMin)),
      note: note.trim() || `${nextStage}工序登记`,
      status: '有效',
    })
    note = ''
    feedback = `已推进到${nextStage}（新有效节点，原记录保留为返工经过）`
    await loadNodes()
  }

  async function retreatNode(): Promise<void> {
    const latest = latestValidNode()
    if (!latest) {
      feedback = '当前没有可回退的有效节点。'
      return
    }
    if (!validateVoidForm()) return

    await voidNodes([latest])
    feedback = `已回退${latest.stage}节点，原节点标记作废并留档`
    voidReason = ''
    await loadNodes()
  }

  async function updateDuration(): Promise<void> {
    const latest = latestValidNode()
    if (!latest) {
      feedback = '登记有效工序节点后才能记录耗时。'
      return
    }
    await db.nodes.update(latest.id, { durationMin: Math.max(0, Number(durationMin)) })
    feedback = `已登记${latest.stage}耗时 ${durationMin} 分钟`
    await loadNodes()
  }

  async function returnToStage(index: number, stage: ProcessStage): Promise<void> {
    // 回到某阶段：只作废该阶段之后的有效节点，目标阶段本身的有效节点保留。
    const targets = validNodes.filter((node) => stages.indexOf(node.stage) > index)
    if (targets.length === 0) {
      feedback = `${stage}阶段之后没有可回退的有效节点。`
      return
    }
    if (!validateVoidForm()) return

    await voidNodes(targets)
    feedback = `已回退到${stage}，其后 ${targets.length} 个节点标记作废并留档`
    voidReason = ''
    await loadNodes()
  }

  function formatTime(value: string): string {
    return value.replace('T', ' ')
  }
</script>

<svelte:head>
  <title>工序节点时间线 · 木版年画刻版工序档案</title>
</svelte:head>

{#if !block}
  <div class="page-heading">
    <div><p class="eyebrow">单块版片工序</p><h1>工序节点时间线</h1><p>正在读取版片与节点档案。</p></div>
  </div>
  <EmptyBox title="未找到这块版片" message="版片档案尚未载入，请从画稿总览重新进入。" />
  <a class="button secondary" use:link href="/drafts">返回画稿总览</a>
{:else}
  <div class="page-heading" data-testid="detail-node">
    <div>
      <p class="eyebrow">单块版片工序</p>
      <h1>{block.blockName}工序节点时间线</h1>
      <p>{block.woodType} · 版厚 {block.thicknessMm} mm · 当前 {block.state}</p>
    </div>
    <a class="button ghost" use:link href={`/drafts/${block.draftId}/blocks`}>返回版片编排台</a>
  </div>

  <section class="panel">
    <div class="panel-heading">
      <div>
        <span class="section-kicker">阶段轨道（只认有效节点）</span>
        <h2>沿工序逐节点留档，回退保留返工经过</h2>
      </div>
      <span class="tag state-{block.state}">{block.state}</span>
    </div>
    <StageRail activeIndex={activeIndex} completedCount={validNodes.length} onselect={returnToStage} />
  </section>

  <div class="timeline-grid">
    <section class="panel form-panel">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">{nextStage ? '下一节点' : '节点齐备'}</span>
          <h2>{nextStage ? `登记${nextStage}环节` : '全部阶段已登记'}</h2>
        </div>
      </div>

      {#if nextStage}
        <div class="form-grid">
          <label>
            <span>操作人</span>
            <input data-testid="field-node-operator" bind:value={operator} placeholder="刻工或画师姓名" />
          </label>
          <label>
            <span>本次耗时（分钟）</span>
            <input data-testid="field-node-duration" type="number" min="0" bind:value={durationMin} />
          </label>
          <label class="wide">
            <span>工序记录</span>
            <textarea data-testid="field-node-note" rows="3" bind:value={note} placeholder="记刀路、试印或修补要点"></textarea>
          </label>
        </div>
        <button class="button primary" data-testid="submit-node" type="button" onclick={advanceNode}>推进到{nextStage}</button>
      {:else}
        <p class="gentle-copy">当前版片已登记全部阶段；如需重做，回退时原节点作废留档，再推进将生成新的有效节点。</p>
      {/if}

      <div class="inline-actions">
        <button class="button secondary" type="button" onclick={updateDuration}>更新末节点耗时</button>
        <button class="button danger" data-testid="retreat-node" type="button" onclick={retreatNode}>回退一个节点</button>
      </div>

      <div class="void-form" data-testid="void-form">
        <p class="void-form-title">回退登记（原节点作废留档，不删除）</p>
        <div class="form-grid">
          <label>
            <span>回退操作人</span>
            <input data-testid="field-void-operator" bind:value={voidOperator} placeholder="执行回退的管事或刻工" />
          </label>
          <label class="wide">
            <span>作废原因</span>
            <textarea data-testid="field-void-reason" rows="2" bind:value={voidReason} placeholder="如：线条崩口需返工重刻，说明返工事由"></textarea>
          </label>
        </div>
      </div>

      {#if feedback}<p class="notice">{feedback}</p>{/if}
    </section>

    <section class="panel timeline-panel">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">已存节点（含返工经过）</span>
          <h2>工序往来</h2>
        </div>
        <strong>有效 {validNodes.length} 条{#if voidedNodes.length > 0} · 作废 {voidedNodes.length} 条{/if}</strong>
      </div>

      {#if nodes.length === 0}
        <EmptyBox title="尚未登记节点" message="从上方的下一阶段开始记录操作人、耗时与工序要点。" />
      {:else}
        <ol class="timeline-list">
          {#each sortBySeq(nodes).reverse() as node (node.id)}
            <li class:voided={node.status === '已作废'}>
              <span class="timeline-dot"></span>
              <div>
                <div class="timeline-title">
                  <strong>
                    {node.stage}
                    {#if node.status === '已作废'}<span class="void-badge">已作废</span>{/if}
                  </strong>
                  <span>第 {node.seq} 节点</span>
                </div>
                <p>{node.note}</p>
                <small>{node.operator} · {formatTime(node.startedAt)} · {node.durationMin} 分钟</small>
                {#if node.status === '已作废'}
                  <p class="void-meta">
                    作废原因：{node.voidReason}
                    <br />回退操作人：{node.voidedBy} · 作废时间：{node.voidedAt ? formatTime(node.voidedAt) : '未记录'}
                  </p>
                {/if}
              </div>
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  </div>
{/if}

<style>
  .void-form {
    margin-top: 1.1rem;
    padding-top: 1rem;
    border-top: 1px dashed var(--line-strong);
  }

  .void-form-title {
    margin: 0 0 0.6rem;
    color: var(--ink-muted);
    font-size: 0.82rem;
    font-weight: 650;
  }

  .void-badge {
    margin-left: 0.45rem;
    padding: 0.1rem 0.42rem;
    border-radius: 999px;
    background: rgba(120, 108, 96, 0.16);
    color: var(--ink-muted);
    font-size: 0.68rem;
    font-weight: 700;
    vertical-align: middle;
  }

  .voided .timeline-dot {
    background: var(--ink-muted);
    box-shadow: 0 0 0 2px rgba(120, 108, 96, 0.2);
  }

  li.voided > div > p,
  li.voided > div > small,
  li.voided .timeline-title span {
    color: var(--ink-muted);
    text-decoration: line-through;
    text-decoration-color: rgba(120, 108, 96, 0.45);
  }

  .void-meta {
    margin: 0.35rem 0 0 !important;
    padding: 0.45rem 0.6rem;
    border-left: 3px solid var(--ink-muted);
    background: rgba(120, 108, 96, 0.07);
    font-size: 0.76rem;
    line-height: 1.6 !important;
    text-decoration: none !important;
  }
</style>
