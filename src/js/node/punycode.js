// node:punycode shim
const maxInt = 2147483647;
const base = 36;
const tMin = 1;
const tMax = 26;
const skew = 38;
const damp = 700;
const initialBias = 72;
const initialN = 128;
const delimiter = "-";

function adapt(delta, numPoints, firstTime) {
  let k = 0;
  delta = firstTime ? Math.floor(delta / damp) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  for (; delta > ((base - tMin) * tMax) >> 1; k += base) {
    delta = Math.floor(delta / (base - tMin));
  }
  return Math.floor(k + ((base - tMin + 1) * delta) / (delta + skew));
}

export function decode(input) {
  const output = [];
  const inputLen = input.length;
  let i = 0;
  let n = initialN;
  let bias = initialBias;
  let basic = input.lastIndexOf(delimiter);
  if (basic < 0) basic = 0;

  for (let j = 0; j < basic; ++j) {
    if (input.charCodeAt(j) >= 0x80) throw new RangeError("Illegal input >= 0x80");
    output.push(input.charCodeAt(j));
  }

  for (let index = basic > 0 ? basic + 1 : 0; index < inputLen; ) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (index >= inputLen) throw new RangeError("Invalid input");
      const digit = input.charCodeAt(index++);
      const val = digit - 48 < 10 ? digit - 22 : digit - 65 < 26 ? digit - 65 : digit - 97 < 26 ? digit - 97 : base;
      if (val >= base) throw new RangeError("Invalid input");
      i += val * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (val < t) break;
      w *= base - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    n += Math.floor(i / out);
    i %= out;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

export function encode(input) {
  const output = [];
  const codePoints = Array.from(input).map((ch) => ch.codePointAt(0));
  const inputLen = codePoints.length;
  let n = initialN;
  let delta = 0;
  let bias = initialBias;

  for (const code of codePoints) {
    if (code < 0x80) output.push(String.fromCharCode(code));
  }
  let h = output.length;
  const b = h;
  if (b > 0) output.push(delimiter);

  while (h < inputLen) {
    let m = maxInt;
    for (const code of codePoints) {
      if (code >= n && code < m) m = code;
    }
    delta += (m - n) * (h + 1);
    n = m;
    for (const code of codePoints) {
      if (code < n && ++delta > maxInt) throw new RangeError("Overflow");
      if (code === n) {
        let q = delta;
        for (let k = base; ; k += base) {
          const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
          if (q < t) break;
          output.push(String.fromCharCode(t + ((q - t) % (base - t)) + 97));
          q = Math.floor((q - t) / (base - t));
        }
        output.push(String.fromCharCode(q < 26 ? q + 97 : q + 22));
        bias = adapt(delta, h + 1, h === b);
        delta = 0;
        ++h;
      }
    }
    ++delta;
    ++n;
  }
  return output.join("");
}

export function toASCII(input) {
  try {
    return new URL(`http://${input}`).hostname;
  } catch {
    return input;
  }
}

export function toUnicode(input) {
  return String(input)
    .split(".")
    .map((part) => (part.startsWith("xn--") ? decode(part.slice(4)) : part))
    .join(".");
}

export const ucs2 = {
  decode(string) {
    return Array.from(string).map((c) => c.codePointAt(0));
  },
  encode(codePoints) {
    return String.fromCodePoint(...codePoints);
  },
};

export const version = "2.3.1";

export default {
  version,
  ucs2,
  decode,
  encode,
  toASCII,
  toUnicode,
};
