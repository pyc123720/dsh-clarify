import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_BRIEF_CHARS,
  PROTOCOL,
  approvedSection,
  cleanBrief,
  reviewDetail,
  sectionText,
} from '../lib/protocol.js'

test('an untouched or switched-off session renders no section at all', () => {
  assert.equal(sectionText(undefined), '')
  assert.equal(sectionText({ enabled: false }), '')
  assert.equal(sectionText({}), '')
  assert.equal(sectionText({ enabled: false, brief: '旧卡', approvedAt: 1 }), '')
})

test('an enabled session without an approved card gets the intake script', () => {
  assert.equal(sectionText({ enabled: true }), PROTOCOL)
  // A card that was never confirmed is not an approved card.
  assert.equal(sectionText({ enabled: true, brief: '目标：做点什么' }), PROTOCOL)
})

test('the intake script tells the model to skip questions that change nothing', () => {
  assert.ok(PROTOCOL.includes('换个答案，我会不会写不同的东西'))
  assert.ok(PROTOCOL.includes('不会就别问'))
  assert.ok(PROTOCOL.includes('changes-wording'))
  assert.ok(PROTOCOL.includes('nice-to-know'))
})

test('the intake script teaches question kinds, quick mode and the checklist', () => {
  assert.ok(PROTOCOL.includes('goal（到底要什么 / 成功标准）只在动手前问'))
  assert.ok(PROTOCOL.includes('已经开工就只问'))
  assert.ok(PROTOCOL.includes('mode=quick'))
  assert.ok(PROTOCOL.includes('mode=full'))
  assert.ok(PROTOCOL.includes('验收清单（3–5 条可勾选）'))
})

test('the approved anchor asks the model to self-check the checklist', () => {
  const text = approvedSection('# 卡')
  assert.ok(text.includes('验收清单'))
  assert.ok(text.includes('逐条说明'))
})

test('the approved card is pasted back verbatim as the anchor', () => {
  const brief = '# 需求卡\n- 目标：一份 8 页的预习报告\n- 交付物：docx'
  const text = sectionText({ enabled: true, brief, approvedAt: 1_700_000_000_000 })
  assert.equal(text, approvedSection(brief))
  assert.ok(text.includes(brief))
  assert.ok(text.includes('需求已确认'))
  // The failure modes the anchor exists to prevent stay named.
  assert.ok(text.includes('不要默默改需求'))
  assert.ok(text.includes('新任务'))
  assert.ok(text.includes('旧卡不作数'))
  assert.ok(text.includes('clarify_ask'))
})

test('a fenced card is unwrapped, and a huge one is truncated', () => {
  assert.equal(cleanBrief('```markdown\n# 需求卡\n目标\n```'), '# 需求卡\n目标')
  assert.equal(cleanBrief('  \n\n# 卡\n\n'), '# 卡')
  assert.equal(cleanBrief(undefined), '')
  assert.equal(cleanBrief(42), '')

  const long = 'x'.repeat(MAX_BRIEF_CHARS + 500)
  const cleaned = cleanBrief(long)
  assert.ok(cleaned.length < long.length)
  assert.ok(cleaned.endsWith('（卡片过长，已截断）'))
})

test('the review detail carries the card and the questions that shaped it', () => {
  const detail = reviewDetail('# 卡', ['要几页？', ' ', '给谁看？'])
  assert.ok(detail.startsWith('# 卡'))
  assert.ok(detail.includes('- 要几页？'))
  assert.ok(detail.includes('- 给谁看？'))
  assert.ok(!detail.includes('-  '))
  assert.equal(reviewDetail('# 卡', []), '# 卡')
})
