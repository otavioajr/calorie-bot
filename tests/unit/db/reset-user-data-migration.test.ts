import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function getEffectiveResetDefinition() {
  const migrationsDir = join(process.cwd(), 'supabase', 'migrations')
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  let resetFunctionBody: string | null = null
  let resetFunctionFile: string | null = null
  let allowedCalorieModes: string[] = []

  for (const file of migrationFiles) {
    const content = readFileSync(join(migrationsDir, file), 'utf8')

    const constraintMatches = [
      ...content.matchAll(/CHECK\s*\(\s*calorie_mode\s+IN\s*\(([^)]+)\)\s*\)/gim),
    ]

    if (constraintMatches.length > 0) {
      const latestConstraint = constraintMatches.at(-1)
      if (latestConstraint) {
        allowedCalorieModes = latestConstraint[1]
          .split(',')
          .map((mode) => mode.replace(/['"\s]/g, ''))
          .filter(Boolean)
      }
    }

    const resetFunctionMatch = content.match(
      /CREATE OR REPLACE FUNCTION reset_user_data\(p_user_id UUID\) RETURNS void AS \$\$([\s\S]*?)\$\$ LANGUAGE plpgsql SECURITY DEFINER;/im,
    )

    if (resetFunctionMatch) {
      resetFunctionBody = resetFunctionMatch[1]
      resetFunctionFile = file
    }
  }

  const assignedModeMatch = resetFunctionBody?.match(/calorie_mode\s*=\s*'([^']+)'/i)

  return {
    assignedMode: assignedModeMatch?.[1] ?? null,
    allowedCalorieModes,
    resetFunctionFile,
  }
}

describe('reset_user_data migration chain', () => {
  it('keeps reset_user_data compatible with the final calorie_mode constraint', () => {
    const { assignedMode, allowedCalorieModes, resetFunctionFile } = getEffectiveResetDefinition()

    expect(resetFunctionFile).toBeTruthy()
    expect(assignedMode).toBeTruthy()
    expect(allowedCalorieModes).toContain('taco')
    expect(allowedCalorieModes).toContain('manual')
    expect(assignedMode).toBe('taco')
    expect(allowedCalorieModes).toContain(assignedMode)
  })
})
