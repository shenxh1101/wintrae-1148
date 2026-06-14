import http from 'http';

const baseUrl = 'localhost';
const port = 3000;
let testUserToken = '';

function request(method: string, path: string, body?: object, headers?: Record<string, string>): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: baseUrl,
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode!, data: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode!, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => {
      console.log(`  ✅ ${name}`);
      passed++;
    })
    .catch((err) => {
      console.log(`  ❌ ${name}`);
      console.log(`     Error: ${err.message}`);
      failed++;
    });
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function ensureUserAndFavorites() {
  const res = await request('GET', '/api/user/profile', undefined, { 'x-user-token': 'test-dashboard-user' });
  const body = res.data;
  const tokenHeader = res.data?.data?.user_token;
  if (tokenHeader) testUserToken = String(tokenHeader);
  else testUserToken = 'test-dashboard-user';

  const headers = { 'x-user-token': testUserToken };
  await request('POST', '/api/user/favorites', { type: 'line', target_id: 1 }, headers);
  await request('POST', '/api/user/favorites', { type: 'line', target_id: 2 }, headers);
  await request('POST', '/api/user/favorites', { type: 'line', target_id: 3 }, headers);
  await request('POST', '/api/user/favorites', { type: 'station', target_id: 2 }, headers);
  await request('POST', '/api/user/favorites', { type: 'station', target_id: 5 }, headers);
}

async function runTests() {
  console.log('\n=== 第四轮功能验收测试 ===\n');

  await ensureUserAndFavorites();
  const authHeaders = { 'x-user-token': testUserToken };

  // 1. 首页出行看板接口
  console.log('1. 首页出行看板接口');
  await test('看板返回收藏线路状态', async () => {
    const res = await request('GET', '/api/user/dashboard', undefined, authHeaders);
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.favorite_lines !== undefined, '有 favorite_lines');
    assert(d.favorite_stations !== undefined, '有 favorite_stations');
    assert(d.announcements !== undefined, '有 announcements');
    assert(d.summary !== undefined, '有 summary');
    assert(d.refreshed_at !== undefined, '有 refreshed_at');
    assert(Array.isArray(d.favorite_lines), 'favorite_lines 是数组');
    assert(Array.isArray(d.favorite_stations), 'favorite_stations 是数组');
    assert(Array.isArray(d.announcements), 'announcements 是数组');
  });

  await test('收藏线路包含运营状态和最近到站', async () => {
    const res = await request('GET', '/api/user/dashboard', undefined, authHeaders);
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.favorite_lines.length > 0, '有收藏线路');
    const line = d.favorite_lines[0];
    assert(line.id !== undefined, '有 id');
    assert(line.line_no !== undefined, '有 line_no');
    assert(line.operation_status !== undefined, '有 operation_status');
    assert(line.stations_count !== undefined, '有 stations_count');
    assert(line.first_station !== undefined, '有 first_station');
    assert(line.last_station !== undefined, '有 last_station');
    assert(line.first_bus !== undefined, '有 first_bus');
    assert(line.last_bus !== undefined, '有 last_bus');
    assert(line.next_arrival !== undefined || line.next_arrival === null, '有 next_arrival 或 null');
    if (line.next_arrival) {
      assert(line.next_arrival.eta_minutes !== undefined, 'next_arrival 有 eta_minutes');
      assert(line.next_arrival.crowd_level !== undefined, 'next_arrival 有 crowd_level');
      assert(line.next_arrival.current_station_name !== undefined, 'next_arrival 有 current_station_name');
    }
  });

  await test('收藏站点包含提醒信息', async () => {
    const res = await request('GET', '/api/user/dashboard', undefined, authHeaders);
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.favorite_stations.length > 0, '有收藏站点');
    const station = d.favorite_stations[0];
    assert(station.id !== undefined, '有 id');
    assert(station.name !== undefined, '有 name');
    assert(Array.isArray(station.reminders), '有 reminders 数组');
  });

  await test('看板包含改线公告', async () => {
    const res = await request('GET', '/api/user/dashboard?city_code=bj', undefined, authHeaders);
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    for (const ann of d.announcements) {
      assert(ann.id !== undefined, '公告有 id');
      assert(ann.title !== undefined, '公告有 title');
    }
  });

  await test('看板 summary 统计正确', async () => {
    const res = await request('GET', '/api/user/dashboard', undefined, authHeaders);
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.summary.favorite_lines_count === d.favorite_lines.length, '线路数量统计正确');
    assert(d.summary.favorite_stations_count === d.favorite_stations.length, '站点数量统计正确');
    assert(d.summary.announcements_count === d.announcements.length, '公告数量统计正确');
  });

  // 2. 换乘方案多种推荐口径
  console.log('\n2. 换乘方案多种推荐口径');
  await test('换乘方案包含三种推荐口径', async () => {
    const res = await request('GET', '/api/transfer/plan?city_code=bj&from_station_id=1&to_station_id=8');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.recommendations !== undefined, '有 recommendations');
    assert(d.strategies !== undefined, '有 strategies');
    assert(d.default_recommended !== undefined, '有 default_recommended');
    assert(Array.isArray(d.strategies), 'strategies 是数组');
    assert(d.strategies.length === 3, '有3种策略');
    assert(d.strategies.includes('fewer_transfers'), '有 fewer_transfers');
    assert(d.strategies.includes('lowest_cost'), '有 lowest_cost');
    assert(d.strategies.includes('fastest'), '有 fastest');
  });

  await test('每种推荐口径包含推荐和备选', async () => {
    const res = await request('GET', '/api/transfer/plan?city_code=bj&from_station_id=1&to_station_id=8');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(Array.isArray(d.recommendations), 'recommendations 是数组');
    assert(d.recommendations.length === 3, '3种推荐');
    for (const rec of d.recommendations) {
      assert(rec.key !== undefined, '有 key');
      assert(rec.label !== undefined, '有 label');
      assert(rec.description !== undefined, '有 description');
      assert(rec.recommended !== undefined, '有 recommended');
      assert(Array.isArray(rec.alternatives), '有 alternatives 数组');
      assert(rec.alternatives.length <= 2, '备选不超过2个');
    }
  });

  await test('少换乘策略优先推荐换乘少的', async () => {
    const res = await request('GET', '/api/transfer/plan?city_code=bj&from_station_id=1&to_station_id=8');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    const fewerTransfers = d.recommendations.find((r: any) => r.key === 'fewer_transfers');
    assert(fewerTransfers, '有 fewer_transfers 推荐');
    const recommended = fewerTransfers.recommended;
    assert(recommended.transfers !== undefined, '有 transfers');
    for (const alt of fewerTransfers.alternatives) {
      assert(alt.transfers >= recommended.transfers, '备选换乘次数不少于推荐');
    }
  });

  await test('最快到达策略优先推荐耗时短的', async () => {
    const res = await request('GET', '/api/transfer/plan?city_code=bj&from_station_id=1&to_station_id=8');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    const fastest = d.recommendations.find((r: any) => r.key === 'fastest');
    assert(fastest, '有 fastest 推荐');
    const recommended = fastest.recommended;
    for (const alt of fastest.alternatives) {
      assert(alt.total_duration_minutes >= recommended.total_duration_minutes, '备选耗时不少于推荐');
    }
  });

  // 3. 站点多线路每线一条优化
  console.log('\n3. 站点多线路每线一条优化');
  await test('top_per_line 返回每条线路一条', async () => {
    const res = await request('GET', '/api/stations/2/arrivals?line_ids=1,3&top_per_line=true');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.arrivals && d.arrivals.length >= 0, '有 arrivals');
    const lineIds = new Set(d.arrivals.map((a: any) => a.line_id + '_' + a.direction));
    assert(lineIds.size === d.arrivals.length, '每条线路+方向只返回一条');
  });

  await test('per_line_limit 可控制每条线路返回数量', async () => {
    const res = await request('GET', '/api/stations/2/arrivals?line_ids=1,3&top_per_line=true&per_line_limit=2');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    const counts: Record<string, number> = {};
    for (const a of d.arrivals) {
      const key = String(a.line_id) + '_' + String(a.direction);
      counts[key] = (counts[key] || 0) + 1;
    }
    for (const [k, v] of Object.entries(counts)) {
      assert(v <= 2, `${k} 返回数量不超过2，实际: ${v}`);
    }
  });

  await test('group_by_line 返回 top_by_line', async () => {
    const res = await request('GET', '/api/stations/2/arrivals?line_ids=1,3&group_by_line=true');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.by_line !== undefined, '有 by_line');
    assert(d.top_by_line !== undefined, '有 top_by_line');
    const lineIds = Object.keys(d.by_line);
    for (const lid of lineIds) {
      assert(d.top_by_line[lid] !== undefined, `top_by_line 包含线路 ${lid}`);
      assert(d.top_by_line[lid].line_id == lid, 'top_by_line 数据正确');
    }
  });

  await test('首屏数据包含完整展示字段', async () => {
    const res = await request('GET', '/api/stations/2/arrivals?line_ids=1,3&top_per_line=true');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    if (d.arrivals.length > 0) {
      const a = d.arrivals[0];
      assert(a.line_id !== undefined, '有 line_id');
      assert(a.line_no !== undefined, '有 line_no');
      assert(a.direction !== undefined, '有 direction');
      assert(a.eta_minutes !== undefined, '有 eta_minutes');
      assert(a.eta_text !== undefined, '有 eta_text');
      assert(a.arrival_status !== undefined, '有 arrival_status');
      assert(a.crowd_level !== undefined, '有 crowd_level');
      assert(a.current_station_name !== undefined, '有 current_station_name');
    }
  });

  // 4. 搜索翻页自动修正
  console.log('\n4. 搜索翻页自动修正');
  await test('页码超出范围自动修正', async () => {
    const res = await request('GET', '/api/lines/search?city_code=bj&page=999&page_size=5');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.page <= d.total_pages, `page(${d.page}) <= total_pages(${d.total_pages})`);
    assert(d.page_adjusted === true, 'page_adjusted 应为 true');
    assert(Array.isArray(d.list), 'list 是数组');
  });

  await test('切筛选条件后页码自动落在有效范围', async () => {
    const res1 = await request('GET', '/api/lines/search?city_code=bj&page=1&page_size=2');
    const res2 = await request('GET', '/api/lines/search?city_code=bj&type=express&page=100&page_size=2');
    assert(res1.statusCode === 200 && res2.statusCode === 200, '状态码正常');
    const d2 = res2.data.data;
    assert(d2.page <= d2.total_pages, `筛选后 page(${d2.page}) <= total_pages(${d2.total_pages})`);
  });

  await test('站点搜索页码自动修正', async () => {
    const res = await request('GET', '/api/stations/search?city_code=bj&page=999&page_size=3');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.page <= d.total_pages, `page(${d.page}) <= total_pages(${d.total_pages})`);
    assert(d.page_adjusted === true, 'page_adjusted 应为 true');
  });

  await test('未超出范围时 page_adjusted 为 false', async () => {
    const res = await request('GET', '/api/lines/search?city_code=bj&page=1&page_size=5');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.page_adjusted === false, 'page_adjusted 应为 false');
  });

  await test('total_pages 至少为1', async () => {
    const kw = encodeURIComponent('不存在的线路');
    const res = await request('GET', `/api/lines/search?city_code=bj&keyword=${kw}&page=1&page_size=5`);
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.total_pages >= 1, `total_pages(${d.total_pages}) >= 1`);
    assert(d.page === 1, `page 为1，实际: ${d.page}`);
  });

  // 回归测试 - 之前的功能保持正常
  console.log('\n5. 回归测试');
  await test('批量线路详情接口正常', async () => {
    const res = await request('POST', '/api/lines/batch', { ids: [1, 2] });
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    assert(res.data.data.returned_count >= 2, '返回至少2条');
  });

  await test('换乘方案分段加总等于总计', async () => {
    const res = await request('GET', '/api/transfer/plan?city_code=bj&from_station_id=1&to_station_id=8');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    for (const plan of d.plans) {
      const totalDuration = plan.segments.reduce((s: number, seg: any) => s + seg.duration_minutes, 0);
      assert(Math.abs(plan.total_duration_minutes - totalDuration) <= 1, '时长加总一致');
      const totalPrice = plan.segments.reduce((s: number, seg: any) => s + seg.ticket_price, 0);
      assert(Math.abs(plan.ticket_price - totalPrice) < 0.01, '票价加总一致');
    }
  });

  await test('站点到站排除已过站车辆', async () => {
    const res = await request('GET', '/api/stations/2/arrivals');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    for (const arr of d.arrivals) {
      assert(arr.target_station_seq > arr.current_station_seq, '目标站在当前站之后');
    }
  });

  console.log(`\n=== 测试完成：${passed} 通过，${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('测试运行失败:', err.message);
  process.exit(1);
});
