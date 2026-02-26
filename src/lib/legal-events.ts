export const LEGAL_MODAL_EVENT = 'rp-legal-modal'

export type LegalModalKind = 'terms' | 'privacy'

export interface LegalModalDetail {
  kind: LegalModalKind
}

export function dispatchLegalModal(kind: LegalModalKind) {
  window.dispatchEvent(
    new CustomEvent<LegalModalDetail>(LEGAL_MODAL_EVENT, { detail: { kind } })
  )
}
