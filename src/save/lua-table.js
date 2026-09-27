// Parses the Lua table literal Balatro writes via STR_PACK (engine/string_packer.lua):
//   return {["key"]=value,[1]=value,...}
// Values: nested tables, %q-quoted strings, numbers (incl. inf/nan spellings), true/false/nil.

export function parseLuaTable(text) {
  const p = new Parser(text);
  p.skipWs();
  if (p.text.startsWith('return', p.i)) { p.i += 6; p.skipWs(); }
  const value = p.parseValue();
  p.skipWs();
  if (p.i < p.text.length) p.fail('trailing content');
  return value;
}

class Parser {
  constructor(text) { this.text = text; this.i = 0; }

  fail(msg) { throw new SyntaxError(`${msg} at offset ${this.i}`); }

  skipWs() {
    const t = this.text;
    while (this.i < t.length) {
      const c = t.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.i++; else break;
    }
  }

  parseValue() {
    const t = this.text;
    if (this.i >= t.length) this.fail('unexpected end');
    const c = t[this.i];
    if (c === '{') return this.parseTable();
    if (c === '"') return this.parseString();
    if (t.startsWith('true', this.i)) { this.i += 4; return true; }
    if (t.startsWith('false', this.i)) { this.i += 5; return false; }
    if (t.startsWith('nil', this.i)) { this.i += 3; return null; }
    return this.parseNumber();
  }

  parseTable() {
    this.i++; // '{'
    const entries = [];
    for (;;) {
      this.skipWs();
      const c = this.text[this.i];
      if (c === undefined) this.fail('expected } before end of input');
      if (c === '}') { this.i++; break; }
      if (c === ',') { this.i++; continue; }
      if (c !== '[') this.fail('expected [');
      this.i++;
      this.skipWs();
      const key = this.parseValue();
      this.skipWs();
      if (this.text[this.i] !== ']') this.fail('expected ]');
      this.i++;
      this.skipWs();
      if (this.text[this.i] !== '=') this.fail('expected =');
      this.i++;
      this.skipWs();
      entries.push([key, this.parseValue()]);
    }
    return toJs(entries);
  }

  parseString() {
    const t = this.text;
    let i = this.i + 1;
    let out = '';
    for (;;) {
      if (i >= t.length) this.fail('unterminated string');
      const c = t[i];
      if (c === '"') { i++; break; }
      if (c !== '\\') { out += c; i++; continue; }
      const d = t[i + 1];
      if (d === undefined) this.fail('unterminated escape');
      if (d >= '0' && d <= '9') {
        let j = i + 1, digits = '';
        while (j < i + 4 && t[j] >= '0' && t[j] <= '9') digits += t[j++];
        out += String.fromCharCode(parseInt(digits, 10));
        i = j;
        continue;
      }
      switch (d) {
        case 'n': case '\n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'a': out += '\x07'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        default: out += d; // \\ \" \'
      }
      i += 2;
    }
    this.i = i;
    return out;
  }

  parseNumber() {
    const t = this.text;
    let j = this.i;
    while (j < t.length && isNumberChar(t.charCodeAt(j))) j++;
    const tok = t.slice(this.i, j);
    if (!tok) this.fail(`unexpected character '${t[this.i]}'`);
    this.i = j;
    const low = tok.toLowerCase();
    const neg = low.startsWith('-');
    if (low.includes('nan') || low.includes('#ind') || low.includes('#qnan')) return NaN;
    if (low === 'inf' || low === '+inf' || low === '-inf' || low.includes('#inf')) return neg ? -Infinity : Infinity;
    const n = Number(tok);
    if (Number.isNaN(n)) this.fail(`bad number '${tok}'`);
    return n;
  }
}

function isNumberChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 43 || c === 45 || c === 35 || c === 40 || c === 41; // . + - # ( )
}

function toJs(entries) {
  if (entries.length === 0) return [];
  const n = entries.length;
  const seen = new Uint8Array(n + 1);
  let isArray = true;
  for (const [k] of entries) {
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > n || seen[k]) { isArray = false; break; }
    seen[k] = 1;
  }
  if (isArray) {
    const arr = new Array(n);
    for (const [k, v] of entries) arr[k - 1] = v;
    return arr;
  }
  const obj = {};
  for (const [k, v] of entries) obj[String(k)] = v;
  return obj;
}
