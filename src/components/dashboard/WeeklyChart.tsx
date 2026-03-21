"use client"

import { useState } from "react"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts"
import { Button } from "@/components/ui/button"

interface DayData {
  date: string
  calories: number
  label: string
}

interface WeeklyChartProps {
  data: DayData[]
  target: number
}

const DAYS_OPTIONS = [7, 30] as const
type DaysOption = (typeof DAYS_OPTIONS)[number]

export function WeeklyChart({ data, target }: WeeklyChartProps) {
  const [days, setDays] = useState<DaysOption>(7)

  const displayData = data.slice(-days)

  return (
    <div className="space-y-4">
      {/* Period selector */}
      <div className="flex items-center justify-end gap-2">
        {DAYS_OPTIONS.map((d) => (
          <Button
            key={d}
            variant={days === d ? "default" : "outline"}
            size="sm"
            onClick={() => setDays(d)}
          >
            {d} dias
          </Button>
        ))}
      </div>

      {/* Chart */}
      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={displayData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
            />
            <YAxis
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
              tickFormatter={(v: number) => `${(v / 1000).toFixed(1)}k`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value) => {
                const num = typeof value === 'number' ? value : 0
                return [`${num.toLocaleString("pt-BR")} kcal`, "Calorias"]
              }}
            />
            <ReferenceLine
              y={target}
              stroke="hsl(var(--secondary))"
              strokeDasharray="6 3"
              label={{ value: "Meta", position: "insideTopRight", fontSize: 11 }}
            />
            <Line
              type="monotone"
              dataKey="calories"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={{ fill: "hsl(var(--primary))", r: 3 }}
              activeDot={{ r: 5, fill: "hsl(var(--primary))" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {displayData.length === 0 && (
        <p className="text-center text-sm text-muted-foreground py-8">
          Nenhum dado disponível para o período selecionado.
        </p>
      )}
    </div>
  )
}
