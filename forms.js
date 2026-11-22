// Translate ACP primitive form fields to the host's question panel. Keep the
// protocol values separate from display labels (labels can be localized).
function choices(field) {
  if (field.type === 'boolean') return [{ label: '是', value: true }, { label: '否', value: false }]
  const spec = field.type === 'array' ? field.items : field
  const titled = spec?.oneOf ?? spec?.anyOf
  if (Array.isArray(titled)) return titled.map(o => ({ label: o.title, value: o.const }))
  return (spec?.enum ?? []).map(value => ({ label: value, value }))
}

export async function elicit(panels, request, signal) {
  if (request.mode !== 'form') return { action: 'decline' }
  const schema = request.requestedSchema
  const properties = schema.properties ?? {}
  const writeIns = new Map()
  for (const [key, field] of Object.entries(properties)) {
    // agy's ask_question pairs q1 (choices) and optional q1_other (free text).
    // The host can collect both parts of an answer in one question.
    const other = key + '_other'
    if (/^q\d+$/.test(key) && choices(field).length && properties[other]?.type === 'string' &&
        !choices(properties[other]).length && !schema.required?.includes(key) && !schema.required?.includes(other)) writeIns.set(key, other)
  }
  const companions = new Set(writeIns.values())
  const fields = Object.entries(properties).filter(([key]) => !companions.has(key))
  if (!fields.length) {
    const answer = await panels.ask([{ question: request.message, options: [{ label: '确认' }, { label: '拒绝' }], hideCustomInput: true }], signal)
    if (!answer) return { action: 'cancel' }
    return answer[0].selected[0] === '确认' ? { action: 'accept', content: {} } : { action: 'decline' }
  }
  const questions = []
  for (const [key, field] of fields) {
    if (!['string','array','number','integer','boolean'].includes(field.type)) return { action: 'decline' }
    const options = choices(field)
    const writeIn = writeIns.has(key)
    const freeOptional = !options.length && !schema.required?.includes(key)
    questions.push({ header: writeIn ? 'Antigravity' : field.title ?? key,
      question: writeIn ? field.title ?? request.message : request.message, detail: field.description,
      options: freeOptional ? [{ label: '跳过（可选）' }] : options.map(o => ({ label: o.label })),
      multiSelect: field.type === 'array', hideCustomInput: !!options.length && !writeIn })
  }
  const answers = await panels.ask(questions, signal)
  if (!answers) return { action: 'cancel' }
  const content = Object.create(null)
  for (const [i, [key, field]] of fields.entries()) {
    const answer = answers[i]
    const options = choices(field)
    if (!options.length && !schema.required?.includes(key) && answer?.selected?.includes('跳过（可选）')) continue
    const other = writeIns.get(key)
    if (other && answer?.custom?.trim()) {
      const value = answer.custom.trim()
      const companion = properties[other]
      if (value.length < (companion.minLength ?? 0) || value.length > (companion.maxLength ?? Infinity)) return { action: 'decline' }
      content[other] = value
      if (!answer.selected?.length && !schema.required?.includes(key)) continue
    }
    const values = (answer?.selected ?? []).map(label => options.find(o => o.label === label)?.value)
    if (values.includes(undefined)) return { action: 'decline' }
    let value = field.type === 'array' ? values : options.length ? values[0] : answer?.custom
    if (value == null || value === '') {
      if (schema.required?.includes(key)) return { action: 'decline' }
      continue
    }
    if (field.type === 'number' || field.type === 'integer') {
      value = Number(value)
      if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value)) ||
          (field.minimum != null && value < field.minimum) || (field.maximum != null && value > field.maximum)) return { action: 'decline' }
    }
    if (typeof value === 'string' && (value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? Infinity))) return { action: 'decline' }
    if (Array.isArray(value) && (value.length < (field.minItems ?? 0) || value.length > (field.maxItems ?? Infinity))) return { action: 'decline' }
    content[key] = value
  }
  return { action: 'accept', content }
}
