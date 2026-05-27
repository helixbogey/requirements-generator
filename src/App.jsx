import { useState, useEffect, useRef } from 'react'

/* ============================================================
 * Requirements Generator
 * ------------------------------------------------------------
 * AI-assisted business analyst tool that turns natural-language
 * project descriptions into structured, MoSCoW-prioritized
 * requirements documents using the Anthropic Claude API.
 *
 * Demonstrates:
 *   - Prompt architecture (structured system prompt + JSON schema)
 *   - Output validation (parse, schema check, fail-fast on drift)
 *   - Guardrail-aware patterns (no invented specifics, marked
 *     assumptions, MoSCoW honesty rules)
 * ============================================================ */

/* ---------- typography & color tokens ---------- */
const FONTS = {
  display: '"Instrument Serif", "Cormorant Garamond", Georgia, serif',
  body: '"DM Sans", system-ui, -apple-system, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
}

const C = {
  paper: '#F5F1E8',
  paperLight: '#FBFAF5',
  ink: '#16161A',
  inkSoft: '#3E3E44',
  inkSubtle: '#8B8B92',
  rule: '#DDD8CB',
  ruleStrong: '#B8B0A0',
  accent: '#A6332E',
  accentSoft: '#F2DDD9',
  accentInk: '#5C1C17',
}

/* ---------- structured prompt (the "prompt architecture") ---------- */
const SYSTEM_PROMPT = `You are a senior business analyst with 15+ years of experience writing specifications for enterprise software. You produce rigorous, testable, MoSCoW-prioritized requirements documents.

Given a project description, produce a requirements document as STRICT JSON matching the schema below. Respond with ONLY the JSON object — no preamble, no markdown fences, no commentary.

SCHEMA:
{
  "executiveSummary": "2-3 sentences capturing purpose, primary users, and core value",
  "stakeholders": [
    { "name": "role/group", "interests": "what they need from the system", "influence": "High" | "Medium" | "Low" }
  ],
  "functionalRequirements": [
    {
      "id": "FR-001",
      "title": "short imperative title",
      "description": "what the system shall do, as a testable behavior",
      "priority": "Must Have" | "Should Have" | "Could Have" | "Won't Have",
      "acceptanceCriteria": ["Given... When... Then... statement"]
    }
  ],
  "nonFunctionalRequirements": [
    {
      "id": "NFR-001",
      "category": "Performance" | "Security" | "Usability" | "Reliability" | "Scalability" | "Maintainability" | "Compliance" | "Accessibility",
      "requirement": "specific measurable constraint with threshold",
      "rationale": "why this matters for this project"
    }
  ],
  "userStories": [
    {
      "id": "US-001",
      "persona": "specific role from stakeholders",
      "want": "capability needed",
      "benefit": "value gained",
      "priority": "Must Have" | "Should Have" | "Could Have" | "Won't Have"
    }
  ],
  "outOfScope": ["specific excluded capability with brief rationale"],
  "risksAndAssumptions": [
    { "type": "Risk" | "Assumption" | "Dependency", "description": "what it is", "mitigation": "how it's addressed or what happens if invalidated" }
  ]
}

QUALITY RULES:
1. Acceptance criteria must be testable Given/When/Then statements. No aspirational language.
2. Use MoSCoW priorities honestly — not everything is Must Have. Aim for roughly 40% Must / 30% Should / 20% Could / 10% Won't.
3. Non-functional requirements include concrete thresholds where reasonable (p95 latency, uptime %, WCAG level). When a threshold is proposed rather than given, mark it as an assumption in risksAndAssumptions.
4. User story personas must match a listed stakeholder name.
5. Out-of-scope items are SPECIFIC adjacent capabilities the project is NOT solving, not generic disclaimers.
6. Never invent business specifics (revenue, user counts, hard deadlines, integrations) absent from the input. Mark inferences as assumptions.

VOLUME (concise specification — quality over quantity):
- 3-4 stakeholders
- 5-7 functional requirements, 1-2 acceptance criteria each
- 3-4 non-functional requirements
- 3-5 user stories
- 2-4 out-of-scope items
- 3-5 risks/assumptions

Return JSON only.`

/* ---------- pre-loaded example (themed for fluent live demo) ---------- */
const EXAMPLE_INPUT = {
  projectName: 'The Circuit — League Operations Platform',
  projectType: 'Internal Tool',
  description: `A 2v2 invite-only competitive Rocket League league. 16 players paired into 8 teams across two conferences. The platform handles weekly series scheduling between team captains, ingests game-by-game stats from Rocket League replay files, computes standings with tiebreakers, and surfaces analytics like Strength of Schedule and Expected Wins. Three league managers need admin tools for roster changes, suspensions, and game corrections. Players see a personal dashboard. Captains see scheduling tools. League managers see and edit everything. A public-facing standings page shows current rankings without exposing private league communications.`,
  stakeholders: `Three co-League Managers with override authority. Eight team captains responsible for scheduling on behalf of their pairs. Sixteen rostered players who consume stats and personal dashboards. An interested public who follows standings. Hosting and analytics costs come out of pocket from the LMs so cost control matters. Player technical sophistication is mixed.`,
}

const PROJECT_TYPES = [
  'Web Application',
  'Mobile Application',
  'Internal Tool',
  'Data Platform',
  'Integration / API',
  'Embedded / IoT',
  'Other',
]

/* ============================================================ */
/* API call + validation                                         */
/* ============================================================ */

async function generateRequirements({ projectName, projectType, description, stakeholders }) {
  const userPrompt = `PROJECT NAME: ${projectName}
PROJECT TYPE: ${projectType}

BUSINESS DESCRIPTION:
${description}

STAKEHOLDER CONTEXT:
${stakeholders?.trim() || '(not provided — infer from description and flag major inferences as assumptions)'}

Return the requirements document as JSON only.`

  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`API request failed (${response.status}). ${errText.slice(0, 200)}`)
  }

  // Consume the SSE stream and accumulate text from content_block_delta events
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulatedText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''

    for (const event of events) {
      const dataLines = event.split('\n').filter((l) => l.startsWith('data: '))
      for (const dataLine of dataLines) {
        const payload = dataLine.slice(6).trim()
        if (!payload) continue
        try {
          const parsed = JSON.parse(payload)
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            accumulatedText += parsed.delta.text
          } else if (parsed.type === 'error') {
            throw new Error(parsed.error?.message || 'Stream error from model.')
          }
        } catch (e) {
          if (e.message?.includes('Stream error')) throw e
          // Ignore non-JSON data lines (heartbeats etc.)
        }
      }
    }
  }

  if (!accumulatedText) throw new Error('Empty response from model.')

  const cleaned = accumulatedText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error('Model did not return valid JSON. Try regenerating.')
  }

  const validation = validateSchema(parsed)
  if (!validation.ok) {
    throw new Error(`Output validation failed: ${validation.error}`)
  }

  return parsed
}

function validateSchema(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'not an object' }

  const required = [
    'executiveSummary',
    'stakeholders',
    'functionalRequirements',
    'nonFunctionalRequirements',
    'userStories',
    'outOfScope',
    'risksAndAssumptions',
  ]
  for (const key of required) {
    if (!(key in obj)) return { ok: false, error: `missing field: ${key}` }
  }

  if (typeof obj.executiveSummary !== 'string' || !obj.executiveSummary.trim()) {
    return { ok: false, error: 'executiveSummary must be a non-empty string' }
  }

  const arrayFields = [
    'stakeholders',
    'functionalRequirements',
    'nonFunctionalRequirements',
    'userStories',
    'outOfScope',
    'risksAndAssumptions',
  ]
  for (const key of arrayFields) {
    if (!Array.isArray(obj[key])) return { ok: false, error: `${key} must be an array` }
  }

  if (obj.functionalRequirements.length === 0) {
    return { ok: false, error: 'no functional requirements generated' }
  }

  // Spot-check a functional requirement
  const fr = obj.functionalRequirements[0]
  if (!fr.id || !fr.title || !fr.priority) {
    return { ok: false, error: 'functional requirements malformed' }
  }

  return { ok: true }
}

/* ============================================================ */
/* Export helpers                                                */
/* ============================================================ */

function generateMarkdown(data, meta) {
  const L = []
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  L.push(`# ${meta.projectName}`, '')
  L.push(`**Project Type:** ${meta.projectType}  `)
  L.push(`**Generated:** ${date}`, '')
  L.push('---', '')

  L.push('## Executive Summary', '', data.executiveSummary, '')

  L.push('## Stakeholders', '')
  for (const s of data.stakeholders) {
    L.push(`- **${s.name}** *(${s.influence} influence)* — ${s.interests}`)
  }
  L.push('')

  L.push('## Functional Requirements', '')
  for (const fr of data.functionalRequirements) {
    L.push(`### ${fr.id} · ${fr.title}`)
    L.push(`*Priority: ${fr.priority}*`, '')
    L.push(fr.description, '')
    if (fr.acceptanceCriteria?.length) {
      L.push('**Acceptance Criteria:**')
      for (const ac of fr.acceptanceCriteria) L.push(`- ${ac}`)
      L.push('')
    }
  }

  L.push('## Non-Functional Requirements', '')
  for (const nfr of data.nonFunctionalRequirements) {
    L.push(`### ${nfr.id} · ${nfr.category}`)
    L.push(nfr.requirement, '')
    L.push(`*Rationale:* ${nfr.rationale}`, '')
  }

  L.push('## User Stories', '')
  for (const us of data.userStories) {
    L.push(`- **${us.id}** *(${us.priority})* — As a **${us.persona}**, I want ${us.want}, so that ${us.benefit}.`)
  }
  L.push('')

  L.push('## Out of Scope', '')
  for (const item of data.outOfScope) L.push(`- ${item}`)
  L.push('')

  L.push('## Risks & Assumptions', '')
  for (const r of data.risksAndAssumptions) {
    L.push(`- **${r.type}:** ${r.description}`)
    L.push(`  *Mitigation:* ${r.mitigation}`)
  }

  return L.join('\n')
}

function downloadFile(content, filename) {
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/* ============================================================ */
/* Small visual components                                       */
/* ============================================================ */

function PriorityPill({ priority }) {
  const styles = {
    'Must Have': { bg: C.accent, fg: '#FFFFFF', border: C.accent },
    'Should Have': { bg: C.ink, fg: C.paper, border: C.ink },
    'Could Have': { bg: 'transparent', fg: C.inkSoft, border: C.ruleStrong },
    "Won't Have": { bg: 'transparent', fg: C.inkSubtle, border: C.rule, italic: true },
  }
  const s = styles[priority] || styles['Could Have']
  return (
    <span
      style={{
        display: 'inline-block',
        fontFamily: FONTS.mono,
        fontSize: '10px',
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '3px 8px',
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.border}`,
        borderRadius: '2px',
        fontStyle: s.italic ? 'italic' : 'normal',
      }}
    >
      {priority}
    </span>
  )
}

function InfluenceBadge({ level }) {
  const styles = {
    High: { dots: 3, color: C.accent },
    Medium: { dots: 2, color: C.ink },
    Low: { dots: 1, color: C.inkSubtle },
  }
  const s = styles[level] || styles['Medium']
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: FONTS.mono, fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: C.inkSoft }}>
      <span style={{ display: 'inline-flex', gap: '2px' }}>
        {[1, 2, 3].map((i) => (
          <span
            key={i}
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: i <= s.dots ? s.color : 'transparent',
              border: `1px solid ${i <= s.dots ? s.color : C.ruleStrong}`,
            }}
          />
        ))}
      </span>
      {level}
    </span>
  )
}

function CategoryBadge({ category }) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontFamily: FONTS.mono,
        fontSize: '10px',
        fontWeight: 500,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: C.accent,
        background: C.accentSoft,
        padding: '3px 8px',
        borderRadius: '2px',
      }}
    >
      {category}
    </span>
  )
}

function TypeBadge({ type }) {
  const colors = {
    Risk: { fg: C.accent, bg: C.accentSoft },
    Assumption: { fg: C.ink, bg: C.paper },
    Dependency: { fg: C.inkSoft, bg: '#EAE4D2' },
  }
  const s = colors[type] || colors['Assumption']
  return (
    <span
      style={{
        display: 'inline-block',
        fontFamily: FONTS.mono,
        fontSize: '10px',
        fontWeight: 600,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: s.fg,
        background: s.bg,
        border: `1px solid ${C.rule}`,
        padding: '2px 7px',
        borderRadius: '2px',
      }}
    >
      {type}
    </span>
  )
}

function SectionHeader({ number, title, count }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '16px', marginBottom: '24px', paddingBottom: '12px', borderBottom: `1px solid ${C.ruleStrong}` }}>
      <span style={{ fontFamily: FONTS.mono, fontSize: '11px', color: C.inkSubtle, letterSpacing: '0.15em' }}>{number}</span>
      <h2 style={{ fontFamily: FONTS.display, fontSize: '28px', fontWeight: 400, color: C.ink, margin: 0, letterSpacing: '-0.01em' }}>
        {title}
      </h2>
      {count != null && (
        <span style={{ fontFamily: FONTS.mono, fontSize: '11px', color: C.inkSubtle, letterSpacing: '0.1em', marginLeft: 'auto' }}>
          {String(count).padStart(2, '0')} {count === 1 ? 'item' : 'items'}
        </span>
      )}
    </div>
  )
}

function IdLabel({ children }) {
  return (
    <span style={{ fontFamily: FONTS.mono, fontSize: '11px', fontWeight: 600, color: C.accent, letterSpacing: '0.05em' }}>
      {children}
    </span>
  )
}

/* ============================================================ */
/* Form                                                          */
/* ============================================================ */

function InputForm({ values, onChange, onSubmit, onLoadExample, onReset, loading, hasOutput }) {
  const charCount = values.description.length

  return (
    <div
      style={{
        background: C.paperLight,
        border: `1px solid ${C.rule}`,
        padding: '32px',
        marginBottom: '64px',
      }}
    >
      <SectionHeader number="01" title="Project input" />

      {/* Project name + type row */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '24px', marginBottom: '24px' }}>
        <div>
          <label style={labelStyle}>Project name</label>
          <input
            type="text"
            value={values.projectName}
            onChange={(e) => onChange('projectName', e.target.value)}
            placeholder="e.g. Customer Onboarding Portal"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>Project type</label>
          <select
            value={values.projectType}
            onChange={(e) => onChange('projectType', e.target.value)}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {PROJECT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Description */}
      <div style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label style={labelStyle}>Business description</label>
          <span style={{ fontFamily: FONTS.mono, fontSize: '10px', color: charCount > 2000 ? C.accent : C.inkSubtle, letterSpacing: '0.05em' }}>
            {charCount} chars
          </span>
        </div>
        <textarea
          value={values.description}
          onChange={(e) => onChange('description', e.target.value)}
          placeholder="What does the system do? Who uses it? What's the core value? Be specific about features, not vague about goals."
          rows={6}
          style={{ ...inputStyle, resize: 'vertical', minHeight: '140px', fontFamily: FONTS.body }}
        />
      </div>

      {/* Stakeholder context */}
      <div style={{ marginBottom: '32px' }}>
        <label style={labelStyle}>
          Stakeholder context <span style={{ fontWeight: 400, color: C.inkSubtle, textTransform: 'none', letterSpacing: 0 }}>— optional</span>
        </label>
        <textarea
          value={values.stakeholders}
          onChange={(e) => onChange('stakeholders', e.target.value)}
          placeholder="Who are the users, decision-makers, and constraints holders? What do they care about? (Leave blank to let the model infer.)"
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', minHeight: '80px', fontFamily: FONTS.body }}
        />
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
        <button
          onClick={onSubmit}
          disabled={loading || !values.projectName.trim() || !values.description.trim()}
          style={{
            fontFamily: FONTS.mono,
            fontSize: '12px',
            fontWeight: 600,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            padding: '14px 28px',
            background: loading ? C.inkSoft : C.ink,
            color: C.paper,
            border: 'none',
            cursor: loading || !values.projectName.trim() || !values.description.trim() ? 'not-allowed' : 'pointer',
            opacity: !values.projectName.trim() || !values.description.trim() ? 0.4 : 1,
            transition: 'all 0.15s ease',
          }}
        >
          {loading ? 'Generating…' : hasOutput ? 'Regenerate →' : 'Generate document →'}
        </button>

        <button
          onClick={onLoadExample}
          disabled={loading}
          style={{
            fontFamily: FONTS.mono,
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            padding: '14px 0',
            background: 'transparent',
            color: C.accent,
            border: 'none',
            borderBottom: `1px solid ${C.accent}`,
            cursor: 'pointer',
          }}
        >
          Load example project
        </button>

        {hasOutput && (
          <button
            onClick={onReset}
            disabled={loading}
            style={{
              fontFamily: FONTS.mono,
              fontSize: '11px',
              fontWeight: 500,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              padding: '14px 0',
              background: 'transparent',
              color: C.inkSubtle,
              border: 'none',
              cursor: 'pointer',
              marginLeft: 'auto',
            }}
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  )
}

const labelStyle = {
  display: 'block',
  fontFamily: FONTS.mono,
  fontSize: '10px',
  fontWeight: 600,
  color: C.inkSoft,
  letterSpacing: '0.15em',
  textTransform: 'uppercase',
  marginBottom: '8px',
}

const inputStyle = {
  width: '100%',
  fontFamily: FONTS.body,
  fontSize: '15px',
  color: C.ink,
  background: C.paper,
  border: `1px solid ${C.rule}`,
  padding: '12px 14px',
  outline: 'none',
  borderRadius: 0,
  boxSizing: 'border-box',
}

/* ============================================================ */
/* Output renderer                                               */
/* ============================================================ */

function RequirementsDocument({ data, meta, onCopy, onDownload, copied }) {
  return (
    <div>
      {/* Document header */}
      <div style={{ marginBottom: '64px', textAlign: 'center', borderBottom: `2px solid ${C.ink}`, paddingBottom: '40px' }}>
        <div style={{ fontFamily: FONTS.mono, fontSize: '11px', color: C.inkSubtle, letterSpacing: '0.25em', textTransform: 'uppercase', marginBottom: '16px' }}>
          Requirements Document · {meta.projectType}
        </div>
        <h1 style={{ fontFamily: FONTS.display, fontSize: 'clamp(36px, 5vw, 56px)', fontWeight: 400, color: C.ink, margin: '0 0 24px', lineHeight: 1.05, letterSpacing: '-0.02em' }}>
          {meta.projectName}
        </h1>
        <div style={{ fontFamily: FONTS.mono, fontSize: '11px', color: C.inkSubtle, letterSpacing: '0.15em' }}>
          {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}
        </div>
      </div>

      {/* Action bar */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '64px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button onClick={onCopy} style={actionButtonStyle}>
          {copied ? '✓ Copied' : 'Copy as Markdown'}
        </button>
        <button onClick={onDownload} style={{ ...actionButtonStyle, background: C.ink, color: C.paper, borderColor: C.ink }}>
          Download .md
        </button>
      </div>

      {/* Executive Summary */}
      <section style={{ marginBottom: '72px' }}>
        <SectionHeader number="01" title="Executive summary" />
        <p style={{ fontFamily: FONTS.display, fontSize: '22px', fontStyle: 'italic', lineHeight: 1.5, color: C.ink, margin: 0, maxWidth: '64ch' }}>
          {data.executiveSummary}
        </p>
      </section>

      {/* Stakeholders */}
      <section style={{ marginBottom: '72px' }}>
        <SectionHeader number="02" title="Stakeholders" count={data.stakeholders.length} />
        <div style={{ display: 'grid', gap: '24px' }}>
          {data.stakeholders.map((s, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '24px', alignItems: 'start' }}>
              <div>
                <div style={{ fontFamily: FONTS.display, fontSize: '20px', color: C.ink, marginBottom: '6px', lineHeight: 1.2 }}>
                  {s.name}
                </div>
                <InfluenceBadge level={s.influence} />
              </div>
              <div style={{ fontSize: '15px', lineHeight: 1.65, color: C.inkSoft, paddingTop: '4px' }}>{s.interests}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Functional Requirements */}
      <section style={{ marginBottom: '72px' }}>
        <SectionHeader number="03" title="Functional requirements" count={data.functionalRequirements.length} />
        <div style={{ display: 'grid', gap: '40px' }}>
          {data.functionalRequirements.map((fr) => (
            <article key={fr.id} style={{ borderLeft: `2px solid ${C.ruleStrong}`, paddingLeft: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap', marginBottom: '8px' }}>
                <IdLabel>{fr.id}</IdLabel>
                <PriorityPill priority={fr.priority} />
              </div>
              <h3 style={{ fontFamily: FONTS.display, fontSize: '24px', fontWeight: 400, color: C.ink, margin: '0 0 12px', lineHeight: 1.25 }}>
                {fr.title}
              </h3>
              <p style={{ fontSize: '15px', lineHeight: 1.65, color: C.inkSoft, margin: '0 0 16px' }}>{fr.description}</p>
              {fr.acceptanceCriteria?.length > 0 && (
                <div style={{ background: C.paperLight, border: `1px solid ${C.rule}`, padding: '16px 20px' }}>
                  <div style={{ fontFamily: FONTS.mono, fontSize: '10px', fontWeight: 600, color: C.inkSoft, letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '10px' }}>
                    Acceptance criteria
                  </div>
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                    {fr.acceptanceCriteria.map((ac, i) => (
                      <li key={i} style={{ display: 'flex', gap: '12px', marginBottom: '8px', fontSize: '14px', lineHeight: 1.6, color: C.ink }}>
                        <span style={{ fontFamily: FONTS.mono, color: C.accent, fontSize: '11px', paddingTop: '3px' }}>›</span>
                        <span>{ac}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      {/* Non-Functional Requirements */}
      <section style={{ marginBottom: '72px' }}>
        <SectionHeader number="04" title="Non-functional requirements" count={data.nonFunctionalRequirements.length} />
        <div style={{ display: 'grid', gap: '32px' }}>
          {data.nonFunctionalRequirements.map((nfr) => (
            <div key={nfr.id}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
                <IdLabel>{nfr.id}</IdLabel>
                <CategoryBadge category={nfr.category} />
              </div>
              <p style={{ fontSize: '16px', lineHeight: 1.6, color: C.ink, margin: '0 0 8px', fontWeight: 500 }}>
                {nfr.requirement}
              </p>
              <p style={{ fontSize: '14px', lineHeight: 1.6, color: C.inkSubtle, margin: 0, fontStyle: 'italic' }}>
                {nfr.rationale}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* User Stories */}
      <section style={{ marginBottom: '72px' }}>
        <SectionHeader number="05" title="User stories" count={data.userStories.length} />
        <div style={{ display: 'grid', gap: '20px' }}>
          {data.userStories.map((us) => (
            <div key={us.id} style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '20px', alignItems: 'baseline', padding: '16px 0', borderBottom: `1px solid ${C.rule}` }}>
              <div>
                <IdLabel>{us.id}</IdLabel>
                <div style={{ marginTop: '8px' }}>
                  <PriorityPill priority={us.priority} />
                </div>
              </div>
              <p style={{ fontSize: '15px', lineHeight: 1.65, color: C.ink, margin: 0 }}>
                As a <strong style={{ color: C.accent }}>{us.persona}</strong>, I want {us.want}, so that {us.benefit}.
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Out of Scope */}
      <section style={{ marginBottom: '72px' }}>
        <SectionHeader number="06" title="Out of scope" count={data.outOfScope.length} />
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {data.outOfScope.map((item, i) => (
            <li key={i} style={{ display: 'flex', gap: '16px', marginBottom: '14px', fontSize: '15px', lineHeight: 1.65, color: C.inkSoft }}>
              <span style={{ fontFamily: FONTS.mono, color: C.inkSubtle, fontSize: '12px', paddingTop: '3px' }}>×</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Risks & Assumptions */}
      <section style={{ marginBottom: '40px' }}>
        <SectionHeader number="07" title="Risks & assumptions" count={data.risksAndAssumptions.length} />
        <div style={{ display: 'grid', gap: '24px' }}>
          {data.risksAndAssumptions.map((r, i) => (
            <div key={i} style={{ padding: '20px', background: C.paperLight, border: `1px solid ${C.rule}` }}>
              <div style={{ marginBottom: '10px' }}>
                <TypeBadge type={r.type} />
              </div>
              <p style={{ fontSize: '15px', lineHeight: 1.6, color: C.ink, margin: '0 0 10px', fontWeight: 500 }}>
                {r.description}
              </p>
              <p style={{ fontSize: '13px', lineHeight: 1.6, color: C.inkSubtle, margin: 0 }}>
                <span style={{ fontFamily: FONTS.mono, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em', color: C.inkSoft, marginRight: '8px' }}>
                  Mitigation
                </span>
                {r.mitigation}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

const actionButtonStyle = {
  fontFamily: FONTS.mono,
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  padding: '10px 18px',
  background: 'transparent',
  color: C.ink,
  border: `1px solid ${C.ink}`,
  cursor: 'pointer',
  transition: 'all 0.15s ease',
}

/* ============================================================ */
/* Empty / loading / error states                                */
/* ============================================================ */

function EmptyState() {
  return (
    <div
      style={{
        border: `1px dashed ${C.ruleStrong}`,
        padding: '64px 32px',
        textAlign: 'center',
        background: 'transparent',
      }}
    >
      <div style={{ fontFamily: FONTS.mono, fontSize: '11px', color: C.inkSubtle, letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: '16px' }}>
        Awaiting input
      </div>
      <p style={{ fontFamily: FONTS.display, fontSize: '22px', fontStyle: 'italic', color: C.inkSoft, margin: '0 auto', maxWidth: '40ch', lineHeight: 1.4 }}>
        Fill in the project details above, or load the example to see a generated specification.
      </p>
    </div>
  )
}

function LoadingState() {
  const [phase, setPhase] = useState(0)
  const phases = ['Parsing business description', 'Extracting stakeholders', 'Drafting requirements', 'Validating output schema']

  useEffect(() => {
    const interval = setInterval(() => {
      setPhase((p) => (p + 1) % phases.length)
    }, 1800)
    return () => clearInterval(interval)
  }, [])

  return (
    <div style={{ border: `1px solid ${C.rule}`, background: C.paperLight, padding: '64px 32px', textAlign: 'center' }}>
      <div style={{ fontFamily: FONTS.mono, fontSize: '11px', color: C.accent, letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: '24px' }}>
        Generating
      </div>
      <p style={{ fontFamily: FONTS.display, fontSize: '24px', fontStyle: 'italic', color: C.ink, margin: '0 0 32px', minHeight: '36px' }}>
        {phases[phase]}…
      </p>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '6px' }}>
        {phases.map((_, i) => (
          <div
            key={i}
            style={{
              width: '40px',
              height: '2px',
              background: i <= phase ? C.accent : C.rule,
              transition: 'background 0.3s ease',
            }}
          />
        ))}
      </div>
    </div>
  )
}

function ErrorState({ message, onRetry }) {
  return (
    <div style={{ border: `1px solid ${C.accent}`, background: C.accentSoft, padding: '32px' }}>
      <div style={{ fontFamily: FONTS.mono, fontSize: '11px', color: C.accentInk, letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: '12px' }}>
        Generation failed
      </div>
      <p style={{ fontFamily: FONTS.body, fontSize: '15px', color: C.accentInk, margin: '0 0 20px', lineHeight: 1.5 }}>
        {message}
      </p>
      <button onClick={onRetry} style={{ ...actionButtonStyle, color: C.accentInk, borderColor: C.accentInk }}>
        Retry
      </button>
    </div>
  )
}

/* ============================================================ */
/* Main component                                                */
/* ============================================================ */

export default function RequirementsGenerator() {
  const [values, setValues] = useState({
    projectName: '',
    projectType: 'Web Application',
    description: '',
    stakeholders: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [output, setOutput] = useState(null)
  const [outputMeta, setOutputMeta] = useState(null)
  const [copied, setCopied] = useState(false)
  const outputRef = useRef(null)

  // Inject Google Fonts
  useEffect(() => {
    const id = 'rg-google-fonts'
    if (document.getElementById(id)) return
    const link = document.createElement('link')
    link.id = id
    link.rel = 'stylesheet'
    link.href =
      'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap'
    document.head.appendChild(link)
  }, [])

  const handleChange = (field, value) => {
    setValues((v) => ({ ...v, [field]: value }))
  }

  const handleLoadExample = () => {
    setValues(EXAMPLE_INPUT)
    setError(null)
  }

  const handleReset = () => {
    setValues({ projectName: '', projectType: 'Web Application', description: '', stakeholders: '' })
    setOutput(null)
    setOutputMeta(null)
    setError(null)
  }

  const handleSubmit = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await generateRequirements(values)
      setOutput(result)
      setOutputMeta({ projectName: values.projectName, projectType: values.projectType })
      // Scroll to output
      setTimeout(() => {
        outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    } catch (e) {
      setError(e.message || 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = async () => {
    if (!output || !outputMeta) return
    const md = generateMarkdown(output, outputMeta)
    try {
      await navigator.clipboard.writeText(md)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Copy failed — your browser may block clipboard access in this context.')
    }
  }

  const handleDownload = () => {
    if (!output || !outputMeta) return
    const md = generateMarkdown(output, outputMeta)
    const slug = outputMeta.projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
    downloadFile(md, `${slug || 'requirements'}.md`)
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: C.paper,
        color: C.ink,
        fontFamily: FONTS.body,
        padding: '64px 24px',
        position: 'relative',
      }}
    >
      {/* Subtle paper texture via radial gradients */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'radial-gradient(circle at 20% 30%, rgba(166,51,46,0.025) 0%, transparent 50%), radial-gradient(circle at 80% 70%, rgba(22,22,26,0.02) 0%, transparent 50%)',
          pointerEvents: 'none',
        }}
      />

      <div style={{ maxWidth: '880px', margin: '0 auto', position: 'relative' }}>
        {/* Header */}
        <header style={{ textAlign: 'center', marginBottom: '72px' }}>
          <div style={{ fontFamily: FONTS.mono, fontSize: '11px', color: C.accent, letterSpacing: '0.3em', textTransform: 'uppercase', marginBottom: '20px' }}>
            ✦ Requirements Generator ✦
          </div>
          <h1
            style={{
              fontFamily: FONTS.display,
              fontSize: 'clamp(48px, 7vw, 88px)',
              fontWeight: 400,
              color: C.ink,
              margin: '0 0 24px',
              lineHeight: 0.95,
              letterSpacing: '-0.03em',
            }}
          >
            From idea <em style={{ color: C.accent }}>to spec.</em>
          </h1>
          <p
            style={{
              fontFamily: FONTS.display,
              fontStyle: 'italic',
              fontSize: 'clamp(18px, 2vw, 22px)',
              color: C.inkSoft,
              margin: '0 auto',
              maxWidth: '52ch',
              lineHeight: 1.5,
            }}
          >
            AI-assisted requirements documents grounded in business analyst best practice — MoSCoW priorities, testable acceptance criteria, marked assumptions.
          </p>
          <div style={{ width: '48px', height: '1px', background: C.ruleStrong, margin: '40px auto 0' }} />
        </header>

        {/* Input form */}
        <InputForm
          values={values}
          onChange={handleChange}
          onSubmit={handleSubmit}
          onLoadExample={handleLoadExample}
          onReset={handleReset}
          loading={loading}
          hasOutput={!!output}
        />

        {/* Output region */}
        <div ref={outputRef}>
          {loading && <LoadingState />}
          {!loading && error && <ErrorState message={error} onRetry={handleSubmit} />}
          {!loading && !error && !output && <EmptyState />}
          {!loading && !error && output && outputMeta && (
            <RequirementsDocument
              data={output}
              meta={outputMeta}
              onCopy={handleCopy}
              onDownload={handleDownload}
              copied={copied}
            />
          )}
        </div>

        {/* Footer */}
        <footer style={{ marginTop: '96px', paddingTop: '32px', borderTop: `1px solid ${C.rule}`, textAlign: 'center' }}>
          <div style={{ fontFamily: FONTS.mono, fontSize: '10px', color: C.inkSubtle, letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: '6px' }}>
            React · Anthropic Claude API · Structured Output Validation
          </div>
          <div style={{ fontFamily: FONTS.display, fontStyle: 'italic', fontSize: '14px', color: C.inkSubtle }}>
            Built by Nicklaus Bogesdorfer
          </div>
        </footer>
      </div>
    </div>
  )
}
