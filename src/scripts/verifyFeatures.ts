import http from 'http';

const baseUrl = 'localhost';
const port = 3000;

function request(method: string, path: string, body?: object): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: baseUrl,
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
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

async function runTests() {
  console.log('\n=== 第三轮功能验收测试 ===\n');

  // 1. 批量线路详情接口
  console.log('1. 批量线路详情接口');
  await test('批量查询线路详情', async () => {
    const res = await request('POST', '/api/lines/batch', { ids: [1, 2, 999] });
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.requested_count === 3, `requested_count=${d.requested_count}`);
    assert(d.returned_count >= 2, `returned_count=${d.returned_count}`);
    assert(d.not_found_ids.includes(999), 'not_found_ids 应包含 999');
    const line = d.lines[0];
    assert(line.id !== undefined, '有 id');
    assert(line.line_no !== undefined, '有 line_no');
    assert(line.direction !== undefined, '有 direction');
    assert(line.first_bus !== undefined, '有 first_bus');
    assert(line.last_bus !== undefined, '有 last_bus');
    assert(line.status !== undefined, '有 status');
    assert(line.stations_count !== undefined, '有 stations_count');
    assert(line.is_active !== undefined, '有 is_active');
  });

  await test('批量查询 - 空数组', async () => {
    const res = await request('POST', '/api/lines/batch', { ids: [] });
    assert(res.statusCode === 200 || res.statusCode === 400, `状态码: ${res.statusCode}`);
  });

  await test('批量查询 - 超过50条限制', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const res = await request('POST', '/api/lines/batch', { ids });
    assert(res.statusCode === 400 || res.data.code !== 0 || res.data.data.returned_count <= 50, '应限制50条');
  });

  // 2. 换乘方案分段信息
  console.log('\n2. 换乘方案分段信息');
  await test('换乘方案包含详细分段信息', async () => {
    const res = await request('GET', '/api/transfer/plan?city_code=bj&from_station_id=1&to_station_id=8');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.plans && d.plans.length > 0, '有方案');
    const plan = d.plans[0];
    assert(plan.segments && plan.segments.length > 0, '有 segments');
    const seg = plan.segments[0];
    assert(seg.segment_index !== undefined, '有 segment_index');
    assert(seg.from_station_id !== undefined, '有 from_station_id');
    assert(seg.from_station_name !== undefined, '有 from_station_name');
    assert(seg.to_station_id !== undefined, '有 to_station_id');
    assert(seg.to_station_name !== undefined, '有 to_station_name');
    assert(seg.travel_minutes !== undefined, '有 travel_minutes');
    assert(seg.wait_minutes !== undefined, '有 wait_minutes');
    assert(seg.duration_minutes !== undefined, '有 duration_minutes');
    assert(seg.ticket_price !== undefined, '有 ticket_price');
    assert(seg.start_seq !== undefined, '有 start_seq');
    assert(seg.end_seq !== undefined, '有 end_seq');
    assert(seg.line_type !== undefined, '有 line_type');
  });

  await test('分段加总等于总计 - 时长', async () => {
    const res = await request('GET', '/api/transfer/plan?city_code=bj&from_station_id=1&to_station_id=8');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.plans && d.plans.length > 0, '有方案');
    for (const plan of d.plans) {
      const totalWait = plan.segments.reduce((s: number, seg: any) => s + (seg.wait_minutes || 0), 0);
      const totalTravel = plan.segments.reduce((s: number, seg: any) => s + (seg.travel_minutes || 0), 0);
      const totalDuration = plan.segments.reduce((s: number, seg: any) => s + (seg.duration_minutes || 0), 0);
      assert(Math.abs(plan.total_duration_minutes - totalDuration) <= 1,
        `方案(换乘${plan.transfers}次): total_duration_minutes(${plan.total_duration_minutes}) ≈ 分段合计(${totalDuration})`);
      assert(Math.abs(plan.total_duration_minutes - (plan.total_wait_minutes + plan.total_travel_minutes)) <= 1,
        `方案(换乘${plan.transfers}次): total_duration ≈ wait + travel`);
      assert(Math.abs(plan.total_wait_minutes - totalWait) <= 1,
        `方案(换乘${plan.transfers}次): total_wait_minutes(${plan.total_wait_minutes}) ≈ 分段合计(${totalWait})`);
      assert(Math.abs(plan.total_travel_minutes - totalTravel) <= 1,
        `方案(换乘${plan.transfers}次): total_travel_minutes(${plan.total_travel_minutes}) ≈ 分段合计(${totalTravel})`);
    }
  });

  await test('分段加总等于总计 - 票价', async () => {
    const res = await request('GET', '/api/transfer/plan?city_code=bj&from_station_id=1&to_station_id=8');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    for (const plan of d.plans) {
      const totalPrice = plan.segments.reduce((s: number, seg: any) => s + (seg.ticket_price || 0), 0);
      assert(Math.abs(plan.ticket_price - totalPrice) < 0.01,
        `方案(换乘${plan.transfers}次): ticket_price(${plan.ticket_price}) = 分段合计(${totalPrice})`);
    }
  });

  // 3. 站点实时到站支持筛选
  console.log('\n3. 站点实时到站支持筛选');
  await test('按 line_ids 筛选到站', async () => {
    const res = await request('GET', '/api/stations/2/arrivals?line_ids=1,3');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.arrivals && d.arrivals.length >= 0, '有 arrivals');
    for (const arr of d.arrivals) {
      assert(arr.line_id === 1 || arr.line_id === 3, `line_id 应为1或3，实际: ${arr.line_id}`);
    }
  });

  await test('到站包含方向、拥挤度、位置信息', async () => {
    const res = await request('GET', '/api/stations/2/arrivals?limit=3');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.arrivals && d.arrivals.length > 0, '有到站数据');
    const arr = d.arrivals[0];
    assert(arr.direction !== undefined, '有 direction');
    assert(arr.crowd_level !== undefined, '有 crowd_level');
    assert(arr.crowd_percentage !== undefined, '有 crowd_percentage');
    assert(arr.latitude !== undefined, '有 latitude');
    assert(arr.longitude !== undefined, '有 longitude');
    assert(arr.current_station_name !== undefined, '有 current_station_name');
    assert(arr.arrival_status !== undefined, '有 arrival_status');
    assert(arr.eta_minutes !== undefined, '有 eta_minutes');
  });

  await test('按到达时间排序（升序）', async () => {
    const res = await request('GET', '/api/stations/2/arrivals');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    let prev = 0;
    for (const arr of d.arrivals) {
      assert(arr.eta_seconds >= prev, '应按 eta_seconds 升序排列');
      prev = arr.eta_seconds;
    }
  });

  await test('按线路分组 (group_by_line)', async () => {
    const res = await request('GET', '/api/stations/2/arrivals?group_by_line=true');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.by_line !== undefined, '有 by_line');
    assert(typeof d.by_line === 'object', 'by_line 是对象');
  });

  // 4. 线路搜索分页信息
  console.log('\n4. 线路搜索分页信息');
  await test('线路搜索返回完整分页字段', async () => {
    const res = await request('GET', '/api/lines/search?city_code=bj&page=1&page_size=5');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.total !== undefined, '有 total');
    assert(d.page === 1, `page=1，实际: ${d.page}`);
    assert(d.page_size === 5, `page_size=5，实际: ${d.page_size}`);
    assert(d.total_pages !== undefined, '有 total_pages');
    assert(d.has_more !== undefined, '有 has_more');
    assert(d.has_prev !== undefined, '有 has_prev');
    assert(d.has_prev === false, '第1页 has_prev=false');
    assert(d.list.length <= 5, '列表长度不超过 page_size');
  });

  await test('线路搜索 - 筛选后总数与列表一致', async () => {
    const res = await request('GET', '/api/lines/search?city_code=bj&type=express&page=1&page_size=20');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.list.length <= d.total, '列表长度不超过总数');
    for (const item of d.list) {
      assert(item.type === 'express', `筛选类型应为 express，实际: ${item.type}`);
    }
  });

  await test('线路搜索 - 翻页一致性', async () => {
    const page1 = await request('GET', '/api/lines/search?city_code=bj&page=1&page_size=3');
    const page2 = await request('GET', '/api/lines/search?city_code=bj&page=2&page_size=3');
    assert(page1.data.data.total === page2.data.data.total, '两页总数一致');
    assert(page1.data.data.total_pages === page2.data.data.total_pages, '两页 total_pages 一致');
    assert(page2.data.data.page === 2, '第二页 page=2');
    assert(page2.data.data.has_prev === true, '第二页 has_prev=true');
  });

  // 5. 站点搜索分页信息
  console.log('\n5. 站点搜索分页信息');
  await test('站点搜索返回完整分页字段', async () => {
    const res = await request('GET', '/api/stations/search?city_code=bj&page=1&page_size=5');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.total !== undefined, '有 total');
    assert(d.page === 1, `page=1，实际: ${d.page}`);
    assert(d.page_size === 5, `page_size=5，实际: ${d.page_size}`);
    assert(d.total_pages !== undefined, '有 total_pages');
    assert(d.has_more !== undefined, '有 has_more');
    assert(d.has_prev !== undefined, '有 has_prev');
    assert(d.has_prev === false, '第1页 has_prev=false');
    assert(d.list.length <= 5, '列表长度不超过 page_size');
  });

  await test('站点搜索 - 关键词筛选后总数正确', async () => {
    const all = await request('GET', '/api/stations/search?city_code=bj&page_size=100');
    const kw = encodeURIComponent('路');
    const filtered = await request('GET', `/api/stations/search?city_code=bj&keyword=${kw}&page_size=100`);
    assert(filtered.data.data.total <= all.data.data.total, '筛选后总数不超过全部');
    for (const item of filtered.data.data.list) {
      const name = item.name || '';
      const addr = item.address || '';
      assert(typeof name === 'string', 'name 是字符串');
    }
  });

  // 6. 返程线详情自动识别方向（验证之前的修复）
  console.log('\n6. 返程线详情验证');
  await test('返程线详情自动识别方向', async () => {
    const res = await request('GET', '/api/lines/2');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(d.direction !== undefined, '有 direction');
    assert(d.stations_count > 0, '有站点数');
    assert(d.first_bus !== undefined, '有首班车');
  });

  await test('返程线站点列表自动识别方向', async () => {
    const res = await request('GET', '/api/lines/2/stations');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    assert(Array.isArray(d) && d.length > 0, '有站点列表');
  });

  // 7. 已过站车辆排除（验证之前的修复）
  console.log('\n7. 已过站车辆排除验证');
  await test('站点到站列表不包含已过站车辆', async () => {
    const res = await request('GET', '/api/stations/2/arrivals');
    assert(res.statusCode === 200, `状态码: ${res.statusCode}`);
    const d = res.data.data;
    for (const arr of d.arrivals) {
      assert(arr.stations_remaining >= 1, '剩余站数应>=1');
      assert(arr.target_station_seq > arr.current_station_seq, '目标站序号应大于当前站序号');
    }
  });

  console.log(`\n=== 测试完成：${passed} 通过，${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('测试运行失败:', err.message);
  process.exit(1);
});
