import { randomUUID } from 'node:crypto'

// dsh-TUI owns focus, keyboard handling, link opening and masked input.
export class Panels {
  constructor(emit) {
    this.emit = emit
    this.pending = new Map()
    this.questions = {
      respond: (id, answer) => this.settle(id, answer.answers),
      cancel: id => this.settle(id),
    }
  }

  ask(questions, signal) {
    if (signal?.aborted) return Promise.resolve()
    const requestId = randomUUID()
    return new Promise(resolve => {
      const abort = () => this.settle(requestId)
      this.pending.set(requestId, answer => {
        signal?.removeEventListener('abort', abort)
        resolve(answer)
      })
      signal?.addEventListener('abort', abort, { once: true })
      this.emit({ type: 'question.request', request: { requestId, questions } })
    })
  }

  settle(id, answer) {
    const resolve = this.pending.get(id)
    if (!resolve) return
    this.pending.delete(id)
    this.emit({ type: 'question.settled', requestId: id })
    resolve(answer)
  }

  close() { for (const id of this.pending.keys()) this.settle(id) }
}
