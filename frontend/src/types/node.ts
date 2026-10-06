export type ProcessStage = '起稿' | '勾描' | '上样' | '刻版' | '修版' | '调色' | '套印' | '晾晒'
export type NodeStatus = '有效' | '已作废'

export interface ProcessNode {
  id: string
  batchId?: string
  blockId?: string
  stage: ProcessStage
  seq: number
  operator: string
  startedAt: string
  durationMin: number
  note: string
  /** 有效节点才计入阶段轨道、平均耗时与导出；作废节点保留为返工经过，仍可在时间线查看。 */
  status: NodeStatus
  /** 作废原因，回退节点时必填。 */
  voidReason?: string
  /** 执行作废操作的人（回退操作人）。 */
  voidedBy?: string
  /** 作废操作时间。 */
  voidedAt?: string
}
