// MCP transport — thin tools over the service, registered on the shared MCP
// server (behind config.mcp.auth.secret). The AI-native tools (draft/preview/
// explain) are the high-value ones. Full reference: docs/09-api.md.

import { z } from 'zod'

export function register(mcp, { service, logger }) {
  const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
  const tool = (name, description, inputSchema, handler) =>
    mcp.tool({ name, description, inputSchema, handler: async (args) => ok(await handler(args)) })

  // --- inspect ---
  tool('audiences_list_rules', 'List all audience rules.', {}, () => service.listRules())
  tool('audiences_get_rule', 'Get one rule.', { id: z.string() }, ({ id }) => service.getRule(id))
  tool('audiences_network_status', 'Networks: eligibility, modes, identity coverage.', {}, () => service.networks())
  tool('audiences_list_facts', 'CRM fact keys available for rule authoring.', {}, () => service.availableFacts())
  tool('audiences_passport_segments', 'Which segments a passport qualifies for.', { passport_id: z.string() }, ({ passport_id }) => service.passportSegments(passport_id))
  tool('audiences_segment_members', 'Count + sample of a rule\'s qualified passports (privacy-gated).', { rule_id: z.string(), limit: z.number().optional() }, ({ rule_id, limit }) => service.members(rule_id, { limit }))
  tool('audiences_explain_match', 'Why a passport qualified (reason + evidence) — the audit trail.', { rule_id: z.string(), passport_id: z.string() }, ({ rule_id, passport_id }) => service.explain(rule_id, passport_id))
  tool('audiences_delivery_log', 'Recent fired events (audit).', { rule_id: z.string().optional(), limit: z.number().optional() }, ({ rule_id, limit }) => service.deliveries({ ruleId: rule_id, limit }))

  // --- author (AI-native) ---
  tool('audiences_draft_rule', 'Draft a structured rule from a natural-language description. Does NOT commit.', { description: z.string() }, ({ description }) => service.draft(description))
  tool('audiences_preview_rule', 'Dry-run a rule (or rule id) through the selector engine: candidate pool, projected matches, sampled judge reasons, full-scan flag. Never fires.', { rule: z.any().optional(), id: z.string().optional(), sample: z.number().optional() }, ({ rule, id, sample }) => service.preview(rule ?? id, { sample }))
  tool('audiences_create_rule', 'Create/replace a rule (commit).', { rule: z.any() }, ({ rule }) => service.saveRule(rule, 'mcp'))
  tool('audiences_enable_rule', 'Enable or disable a rule.', { id: z.string(), enabled: z.boolean() }, ({ id, enabled }) => service.setEnabled(id, enabled))

  // --- act (guarded) ---
  tool('audiences_evaluate', 'Evaluate a rule now and fire events. dryRun defaults TRUE — pass dryRun:false to actually fire.', { rule_id: z.string(), dryRun: z.boolean().optional() }, ({ rule_id, dryRun }) => service.evaluateRule(rule_id, { dryRun: dryRun !== false }))
  tool('audiences_suppress', 'Add a passport to the do-not-target list.', { passport_id: z.string(), reason: z.string().optional() }, ({ passport_id, reason }) => service.suppress(passport_id, reason).then(() => ({ ok: true })))

  logger?.info?.('Audiences: MCP tools registered')
}
