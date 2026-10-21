// 地图：读服务端提供的 /map.tmj（Tiled 编辑器的 JSON 地图）。
// 服务端用同一个文件做碰撞，所以前端画出来的物件和服务端挡路的位置总是一致的。
//
// 用到的图层（都是对象图层，见 docs/modules/map.md）：
//   zones  点对象，名字是区域种类（village、meadow、forest、graveyard、camp），决定地表怎么画
//   roads  折线对象，石板路
//   props  点对象是物件（类 = 种类，属性 s / v / flip），两点折线是一段墙

export interface MapProp {
  kind: string;
  x: number;
  y: number;
  s: number;
  variant: number;
  flip: boolean;
  dx?: number;        // 墙段：终点相对 (x, y) 的偏移，未缩放
  dy?: number;
}

export type Pt = [number, number];

export interface MapData {
  w: number;
  h: number;
  props: MapProp[];
  zones: Record<string, { x: number; y: number }[]>;   // 区域种类 -> 各个区域中心
  roads: Pt[][];
  key: string;        // 文件内容，用来判断地图有没有变
}

interface TmjProp { name: string; value: unknown }
interface TmjObject {
  id: number; name?: string; type?: string; class?: string;
  x: number; y: number; point?: boolean; polyline?: { x: number; y: number }[];
  properties?: TmjProp[];
}
interface TmjLayer { name: string; type: string; objects?: TmjObject[]; layers?: TmjLayer[] }

// loadMap 下载并解析地图；没有地图文件时返回一张空地图。
export async function loadMap(url = '/map.tmj'): Promise<MapData | null> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  return parseMap(text);
}

export function parseMap(text: string): MapData {
  const m = JSON.parse(text);
  const out: MapData = {
    w: m.width * m.tilewidth, h: m.height * m.tileheight, props: [], zones: {}, roads: [], key: text,
  };
  for (const o of layer(m.layers, 'zones')) {
    if (o.name) (out.zones[o.name] ??= []).push({ x: o.x, y: o.y });
  }
  for (const o of layer(m.layers, 'roads')) {
    if (o.polyline?.length > 1) out.roads.push(o.polyline.map((p) => [o.x + p.x, o.y + p.y] as Pt));
  }
  for (const o of layer(m.layers, 'props')) {
    const kind = o.type || o.class;
    if (!kind) continue;
    const prop = (name: string) => o.properties?.find((p) => p.name === name)?.value;
    const p: MapProp = {
      kind, x: o.x, y: o.y,
      s: Number(prop('s') ?? 1), variant: Number(prop('v') ?? 0), flip: prop('flip') === true,
    };
    if (o.polyline?.length === 2) {
      // 和服务端一样：起点是折线第一点，dx / dy 除以 s
      const [a, b] = o.polyline;
      p.x += a.x;
      p.y += a.y;
      p.dx = (b.x - a.x) / p.s;
      p.dy = (b.y - a.y) / p.s;
    }
    out.props.push(p);
  }
  return out;
}

// layer 按名字找对象图层（会进入图层组）。
function layer(layers: TmjLayer[] | undefined, name: string): TmjObject[] {
  for (const l of layers || []) {
    if (l.type === 'objectgroup' && l.name === name) return l.objects || [];
    const inner = layer(l.layers, name);
    if (inner.length) return inner;
  }
  return [];
}
