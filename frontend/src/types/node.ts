export type ProcessStage = '起稿' | '勾描' | '上样' | '刻版' | '修版' | '调色' | '套印' | '晾晒'

export type NodeStatus = '有效' | '作废'

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
  status: NodeStatus
  voidReason?: string
  voidedBy?: string
  voidedAt?: string
}

export function isActiveNode(node: ProcessNode): boolean {
  return node.status !== '作废'
}
