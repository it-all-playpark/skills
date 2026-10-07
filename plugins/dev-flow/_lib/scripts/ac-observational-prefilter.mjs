// ac-observational-prefilter.mjs - 観測型 AC の正規表現の絞り込み（_lib/ac-actor.mjs の isObservationalAc）を
// shell から呼ぶ CLI（issue #859）。prerun-analyze.sh が当たった AC だけを Jev に聞く。
// 規則は ac-actor.mjs の 1 か所に置き、shell 側に写しを持たない。
//
// Usage: node ac-observational-prefilter.mjs < <AC 文字列の JSON 配列>
// stdout: AC ごとの boolean の JSON 配列（1 行）
import { readFileSync } from 'node:fs'
import { acObservationalOf } from '../ac-actor.mjs'

const acs = JSON.parse(readFileSync(0, 'utf8'))
if (!Array.isArray(acs)) throw new Error('stdin must be a JSON array of acceptance criteria')
process.stdout.write(`${JSON.stringify(acObservationalOf(acs))}\n`)
