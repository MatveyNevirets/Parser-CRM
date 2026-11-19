import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migrations = new URL('../supabase/migrations/', import.meta.url)
const apply = async (db, file) => db.exec(await readFile(new URL(file, migrations), 'utf8'))
const bootstrap = (db) => db.exec(`
  create role anon;
  create role authenticated;
  create schema auth;
  create table auth.users (id uuid primary key, email text, phone text, created_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  grant usage on schema auth to authenticated;
  create publication supabase_realtime;
`)

test('import migration installs on a CRM without the optional parser migrations and can be reapplied', async () => {
  const db = new PGlite()
  try {
    await bootstrap(db)
    await apply(db, '202610180001_team_crm.sql')
    await apply(db, '202611180001_sales_workflows.sql')
    const user = randomUUID()
    await db.query('insert into auth.users values ($1)', [user])
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user])
    await db.exec('set role authenticated')
    const team = (await db.query("select public.create_workspace('Минимальная схема') as id")).rows[0].id
    await db.exec('reset role')
    const importMigration = '202611180002_sales_import.sql'
    await apply(db, importMigration)
    await db.exec('set role authenticated')
    const key = randomUUID()
    const card = {
      candidate_id: randomUUID(), source_card_id: '100', company_name: 'Ромашка', city: 'Казань', niche: 'Кафе',
      source_url: 'https://2gis.ru/kazan/firm/100', user_decision: 'include', import_status: 'ready',
      validation_errors: [], branch_classification: 'none', branch_override: 'unreviewed',
      website_check_status: 'present', website: 'https://company.example',
    }
    const publish = async (id) => (await db.query(
      'select public.publish_local_import_candidates($1, $2, $3, true, $4::jsonb, 0, false) report',
      [team, '2gis', id, JSON.stringify([card])],
    )).rows[0].report
    await assert.rejects(() => db.query(
      'select public.preview_local_import_publication($1, $2, $3::jsonb, 0)',
      [team, '2gis', JSON.stringify([card])],
    ), /найден сайт/)
    const created = await publish(key)
    assert.equal(created.created, 1)
    await db.query('update public.leads set archived_at = now() where id = $1', [created.items[0].lead_id])
    await db.exec('reset role')
    await apply(db, importMigration)
    await db.exec('set role authenticated')
    assert.deepEqual(await publish(key), created)
    assert.equal((await publish(randomUUID())).already_exists, 1)
    await assert.rejects(() => db.query(
      'select private.local_import_candidate_exists($1, $2, $3::jsonb)', [team, '2gis', JSON.stringify(card)],
    ), /permission denied/)
  } finally { await db.close() }
})

test('parser publication and sales workflows in PostgreSQL', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pahota-sales-postgres-'))
  let db = new PGlite(directory)
  const userId = randomUUID()
  const workspaceId = randomUUID()
  try {
    await bootstrap(db)
    const files = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()
    for (const file of files.filter((name) => name < '20261118')) {
      await apply(db, file)
    }
    await db.query('insert into auth.users values ($1)', [userId])
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId])
    await db.query('insert into public.workspaces(id, name, owner_id) values ($1, $2, $3)', [workspaceId, 'Тест', userId])
    await db.query('insert into public.workspace_members(workspace_id, user_id) values ($1, $2)', [workspaceId, userId])

    const { rows: [legacy] } = await db.query(
      "insert into public.leads(workspace_id, company_name, niche, status, notes, yandex_maps_url) values ($1, 'Старая карточка', 'Кафе', 'qualified', 'Контакт 2025', 'https://yandex.ru/maps/org/123') returning id",
      [workspaceId],
    )
    for (const file of files.filter((name) => name >= '20261118')) {
      await apply(db, file)
    }
    assert.deepEqual((await db.query(
      'select status, notes, yandex_maps_url, archived_at, manually_queued_for_calls from public.leads where id = $1', [legacy.id],
    )).rows[0], { status: 'inProgress', notes: 'Контакт 2025', yandex_maps_url: 'https://yandex.ru/maps/org/123',
      archived_at: null, manually_queued_for_calls: false })

    const card = (id, overrides = {}) => ({
      candidate_id: randomUUID(), source: '2gis', source_card_id: id, company_name: `Компания ${id}`, city: 'Казань',
      address: `ул. Ленина, ${id}`, niche: 'Кафе', phone: null, website: null,
      website_check_status: 'absent', source_url: `https://2gis.ru/kazan/firm/${id}`,
      website_check_version: 2, website_checked_at: new Date().toISOString(), website_checked_source_url: `https://2gis.ru/kazan/firm/${id}`,
      user_decision: 'include', import_status: 'ready', validation_errors: [], duplicate_kind: null,
      branch_classification: 'none', branch_override: 'unreviewed', ...overrides,
    })
    const preview = async (cards, workspace = workspaceId) => (await db.query(
      'select public.preview_local_import_publication($1, $2, $3::jsonb, 0) report',
      [workspace, '2gis', JSON.stringify(cards)],
    )).rows[0].report
    const publish = async (cards, key = randomUUID()) => (await db.query(
      'select public.publish_local_import_candidates($1, $2, $3, true, $4::jsonb, 0) report',
      [workspaceId, '2gis', key, JSON.stringify(cards)],
    )).rows[0].report

    await t.test('invite admits more than two members and preserves workspace isolation', async () => {
      const members = Array.from({ length: 5 }, () => randomUUID())
      const setActor = (actor) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [actor])
      for (const member of members) await db.query('insert into auth.users values ($1)', [member])
      await setActor(members[0])
      await db.exec('set role authenticated')
      try {
        const { rows: [{ id: team }] } = await db.query("select public.create_workspace('Команда из пяти человек') as id")
        const { rows: [{ invite_code: invite }] } = await db.query('select invite_code from public.workspaces where id = $1', [team])
        const { rows: [{ id: lead }] } = await db.query(
          "insert into public.leads(workspace_id, company_name, niche) values ($1, 'Общий лид', 'Кафе') returning id", [team],
        )
        const join = async (code) => (await db.query('select public.join_workspace($1) as id', [code])).rows[0].id
        for (const member of members.slice(1)) {
          await setActor(member)
          assert.deepEqual((await db.query('select id from public.leads where id = $1', [lead])).rows, [])
          assert.equal(await join(invite), team)
          assert.equal(await join(invite), team)
          assert.deepEqual((await db.query('select id from public.leads where id = $1', [lead])).rows, [{ id: lead }])
        }
        await setActor(userId)
        await assert.rejects(() => join(invite), /другой команде/)
        await assert.rejects(() => join('invalid'), /Код команды не найден/)
        await db.exec('reset role')
        assert.equal((await db.query('select count(*)::int as count from public.workspace_members where workspace_id = $1', [team])).rows[0].count, 5)
      } finally {
        await db.exec('reset role')
        await setActor(userId)
      }
    })

    await t.test('analytics isolate employees, reconcile exactly 55, and protect earnings', async () => {
      const owner = randomUUID()
      const employee = randomUUID()
      const foreign = randomUUID()
      const team = randomUUID()
      const lead = randomUUID()
      const secondLead = randomUUID()
      const earning = randomUUID()
      const setActor = (actor) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [actor])
      for (const [id, email] of [[owner, 'owner@example.test'], [employee, 'employee@example.test'], [foreign, 'other@example.test']]) {
        await db.query('insert into auth.users(id,email) values ($1,$2)', [id,email])
      }
      await db.query("insert into public.workspaces(id, name, owner_id) values ($1, 'Аналитика', $2)", [team, owner])
      await db.query('insert into public.workspace_members(workspace_id,user_id) values ($1,$2),($1,$3)', [team, owner, employee])
      await setActor(owner)
      await db.query("insert into public.leads(id,workspace_id,company_name,niche) values ($1,$3,'Лид 1','Кафе'),($2,$3,'Лид 2','Кафе')",
        [lead, secondLead, team])
      const { rows: [clock] } = await db.query(
        "select ((now() at time zone 'Europe/Volgograd')::date - 1)::text || 'T12:00:00' as cutoff, (now() at time zone 'Europe/Volgograd')::date::text as today",
      )
      const seed = (count) => db.query(
        "insert into public.lead_outreach(id,workspace_id,lead_id,created_by,kind,occurred_at) select gen_random_uuid(), $1,$2,$3,'telegram_message', ($4::timestamp at time zone 'Europe/Volgograd') - interval '1 hour' from generate_series(1,$5::integer)",
        [team, lead, employee, clock.cutoff, count],
      )
      await seed(39)
      const one = async (sql, params) => (await db.query(sql, params)).rows[0].value
      const personal = (id) => one('select public.crm_employee_activity($1,$2) value', [team,id])
      const shared = () => one('select public.crm_team_activity($1) value', [team])
      const members = () => one('select public.crm_team_members($1) value', [team])
      const leaderboard = (date, period) => one('select public.crm_mailing_leaderboard($1,$2,$3) value', [team, date, period])
      const reconcile = (recorded) => one('select public.crm_reconcile_mailing($1,$2,$3) value', [team, clock.cutoff, recorded])
      const save = (amount, version) => db.query(
        'select public.crm_save_earning($1,$2,$3,$4,$5,$6,$7,$8)',
        [team, employee, earning, version, amount, clock.today, 'Работа по лиду', lead],
      )
      const correct = (id, delta) => db.query(
        "select public.crm_add_activity_correction($1,$2,$3,$4::timestamp - interval '1 hour',$5,'Сверка с журналом')",
        [team, employee, id, clock.cutoff, delta],
      )
      await db.exec('set role authenticated')
      try {
        await setActor(employee)
        assert.equal((await personal(employee)).counts.total, 39)
        assert.equal((await personal(employee)).earnings.total, 0)
        assert.equal((await shared()).earnings, null)
        await assert.rejects(() => personal(owner), /администратору/)
        await assert.rejects(() => members(), /администратору/)
        await assert.rejects(() => leaderboard(clock.today, 'week'), /администратору/)
        await assert.rejects(() => reconcile(39), /администратору/)
        await assert.rejects(() => save(10550, null), /администратору/)
        await assert.rejects(() => correct(randomUUID(), 3), /администратору/)
        await assert.rejects(() => db.query('select * from public.crm_activity_correction_history($1,$2)', [team,employee]), /администратору/)
        await assert.rejects(() => db.query('select public.crm_earnings_history($1,$2)', [team, owner]), /администратору/)
        await assert.rejects(() => db.query('select created_by from public.lead_outreach where lead_id=$1', [lead]), /permission denied/)
        assert.equal((await db.query('select id,kind,occurred_at from public.lead_outreach where lead_id=$1', [lead])).rows.length, 39)
        await setActor(owner)
        await assert.rejects(() => db.query(
          "select public.crm_reconcile_mailing($1,$2::timestamp - interval '1 day',0)", [team, clock.cutoff],
        ), /Укажите источник/)
        assert.deepEqual(await reconcile(null), { recorded: 39, additional: 16, applied: false })
        assert.equal((await shared()).reconciliation, null)
        await assert.rejects(() => reconcile(40), /изменилось/)
        assert.deepEqual(await reconcile(39), { recorded: 39, additional: 16, applied: true })
        await reconcile(39)
        const first = await shared()
        assert.equal(first.counts.total + first.reconciliation.additional, 55)
        assert.equal(first.counts.day, 0)
        assert.equal(Object.values(first.daily).reduce((sum, v) => sum + v, 0), 39)
        await save(10550, null)
        await save(10550, null)
        await save(12075, 1)
        await assert.rejects(() => save(10000, 1), /изменилось/)
        assert.equal((await personal(employee)).earnings.day, 12075)
        assert.equal((await shared()).earnings.total, 12075)
        assert.equal((await members()).find((person) => person.id === employee).earnings, 12075)
        assert.equal((await db.query('select * from public.crm_earnings_history($1,$2)', [team,employee])).rows.length, 1)
        const message = randomUUID()
        await db.query('select public.mark_mailing_message($1,$2,1)', [secondLead,message])
        await db.query('select public.mark_mailing_message($1,$2,1)', [secondLead,message])
        const updated = await shared()
        assert.equal(updated.counts.total + updated.reconciliation.additional, 56)
        assert.equal(updated.counts.day, 1)
        assert.equal(Object.values(updated.hourly).reduce((sum, v) => sum + v, 0), 1)
        assert.equal((await personal(owner)).counts.total, 1)
        assert.equal((await personal(employee)).counts.total, 39)
        await db.exec('reset role')
        await seed(1)
        await db.exec('set role authenticated')
        const recovered = await shared()
        assert.equal(recovered.reconciliation.additional, 15)
        assert.equal(recovered.counts.total + recovered.reconciliation.additional, 56)
        assert.equal((await db.query('select workspace_id from public.crm_activity_updates where workspace_id=$1', [team])).rows.length, 1)
        await setActor(foreign)
        await assert.rejects(() => shared(), /Нет доступа/)
        assert.deepEqual((await db.query('select workspace_id from public.crm_activity_updates where workspace_id=$1', [team])).rows, [])
        await db.close()
        db = new PGlite(directory)
        await setActor(owner)
        await db.exec('set role authenticated')
        assert.equal((await shared()).reconciliation.additional, 15)
        assert.equal((await personal(employee)).earnings.total, 12075)
        const correction = randomUUID()
        const priorDay = clock.cutoff.slice(0, 10)
        await correct(correction, 3)
        await correct(correction, 3)
        await assert.rejects(() => correct(correction, 4), /другими данными/)
        const corrected = await personal(employee)
        assert.equal(corrected.counts.total, 43)
        assert.equal(corrected.daily[priorDay], 43)
        assert.equal((await members()).find((person) => person.id === employee).total, 43)
        assert.equal((await shared()).reconciliation.additional, 12)
        assert.equal((await db.query('select id from public.lead_outreach where lead_id = $1', [lead])).rows.length, 40)
        await assert.rejects(() => correct(randomUUID(), -44), /не может быть отрицательным/)
        await correct(randomUUID(), -3)
        assert.equal((await personal(employee)).counts.total, 40)
        assert.equal((await db.query('select * from public.crm_activity_correction_history($1,$2)', [team,employee])).rows.length, 2)
        const daily = (user, id, date, delta) => db.query(
          'select public.crm_add_daily_activity_correction($1,$2,$3,$4,$5)', [team,user,id,date,delta],
        )
        const dailyId = randomUUID()
        await daily(employee, dailyId, clock.today, 3)
        await daily(employee, dailyId, clock.today, 3)
        const employeeDay = await personal(employee)
        assert.equal(employeeDay.counts.day, 3)
        assert.equal(employeeDay.daily[clock.today], 3)
        assert.deepEqual(employeeDay.hourly, {})
        await daily(employee, randomUUID(), priorDay, -2)
        assert.equal((await personal(employee)).daily[priorDay], 38)
        const dailyLeaders = await leaderboard(priorDay, 'day')
        assert.equal(dailyLeaders.start, priorDay)
        assert.equal(dailyLeaders.end, priorDay)
        assert.deepEqual(dailyLeaders.members.map(({ id, position, total }) => ({ id, position, total })),
          [{ id: employee, position: 1, total: 38 }, { id: owner, position: 2, total: 0 }])
        assert.deepEqual(dailyLeaders.members[0].daily, { [priorDay]: 38 })
        const weeklyLeaders = await leaderboard(priorDay, 'week')
        assert.equal(new Date(`${weeklyLeaders.start}T00:00:00Z`).getUTCDay(), 1)
        assert.equal(weeklyLeaders.members[0].daily[priorDay], 38)
        assert.equal((await leaderboard(priorDay, 'month')).start, `${priorDay.slice(0, 7)}-01`)
        await assert.rejects(() => leaderboard(clock.today, 'year'), /Выберите день/)
        await assert.rejects(() => db.query('select public.crm_mailing_leaderboard($1,$2::date + 1,$3)', [team, clock.today, 'day']),
          /Выберите день/)
        await assert.rejects(() => daily(employee, randomUUID(), priorDay, -39), /день не может быть отрицательным/)
        await setActor(employee)
        await assert.rejects(() => daily(employee, randomUUID(), clock.today, 1), /администратору/)
        await setActor(owner)
        await save(0, 2)
        assert.equal((await personal(employee)).earnings.total, 0)
      } finally { await db.exec('reset role'); await setActor(userId) }
    })

    await t.test('mailing message moves the lead once and preserves history on retry', async () => {
      await db.exec('set role authenticated')
      try {
        const { rows: [lead] } = await db.query(
          "insert into public.leads(workspace_id, company_name, niche) values ($1, 'Рассылка тест', 'Кафе') returning id, version", [workspaceId],
        )
        const id = randomUUID()
        const mark = (message, version) => db.query('select public.mark_mailing_message($1,$2,$3)', [lead.id, message, version])
        await assert.rejects(() => mark(randomUUID(), lead.version - 1), /Карточка изменилась/)
        await mark(id, lead.version)
        await mark(id, lead.version)
        await assert.rejects(() => mark(randomUUID(), lead.version + 1), /вышла из рассылки/)
        assert.deepEqual((await db.query('select status, version from public.leads where id = $1', [lead.id])).rows,
          [{ status: 'inProgress', version: lead.version + 1 }])
        assert.deepEqual((await db.query('select id, kind from public.lead_outreach where lead_id = $1', [lead.id])).rows,
          [{ id, kind: 'telegram_message' }])
        await assert.rejects(() => db.query("update public.leads set status = 'contacted' where id = $1", [lead.id]), /leads_status_check/)
        await assert.rejects(() => db.query("update public.leads set status = 'qualified' where id = $1", [lead.id]), /leads_status_check/)
      } finally { await db.exec('reset role') }
    })

    await t.test('verified absence creates a noWebsite lead and retries return the same report', async () => {
      const candidate = card('100')
      const key = randomUUID()
      assert.equal((await preview([candidate])).to_create, 1)
      const report = await publish([candidate], key)
      assert.equal(report.created, 1)
      assert.equal(report.failed, 0)
      const lead = (await db.query('select website, website_status from public.leads where id = $1', [report.items[0].lead_id])).rows[0]
      assert.deepEqual(lead, { website: null, website_status: 'noWebsite' })
      assert.deepEqual(await publish([candidate], key), report)
      assert.equal((await publish([candidate])).already_exists, 1)
      await assert.rejects(() => publish([{ ...candidate, niche: 'Другая' }], key), /другим содержимым/)
    })
    await t.test('manual existing lead matches normalized name/phone despite another niche and missing city', async () => {
      await db.query('insert into public.leads(workspace_id, company_name, niche, phone) values ($1, $2, $3, $4)',
        [workspaceId, '«ООО Ромашка»', 'Рестораны', '8 (999) 123-45-67'])
      const candidate = card('200', { company_name: 'РОМАШКА', phone: '+7 999 123 45 67' })
      assert.equal((await preview([candidate])).already_exists, 1)
      const result = await publish([candidate])
      assert.equal(result.already_exists, 1)
      assert.equal(result.created, 0)
    })
    await t.test('duplicates within one request agree between preview and publication', async () => {
      const cards = [card('300', { company_name: 'Одна компания' }), card('301', {
        company_name: 'Одна компания', address: 'ул. Ленина, 300', niche: 'Другая ниша',
      })]
      const before = await preview(cards)
      assert.equal(before.to_create, 1)
      assert.equal(before.already_exists, 1)
      const result = await publish(cards)
      assert.equal(result.created, 1)
      assert.equal(result.already_exists, 1)
      assert.equal(result.failed, 0)
    })
    await t.test('site evidence and possible duplicates fail before writing', async () => {
      for (const overrides of [{ website: 'https://example.org' }, { website_check_status: 'present' },
        { duplicate_kind: 'possible' }]) {
        const candidate = card('400', overrides)
        await assert.rejects(() => preview([candidate]), /найден сайт или дубль/i)
        await assert.rejects(() => publish([candidate]), /найден сайт или дубль/i)
      }
      assert.equal((await db.query("select count(*)::integer count from public.leads where import_source_id = '400'")).rows[0].count, 0)
    })
    await t.test('unchecked, legacy and manually added empty-site cards can be published', async () => {
      let index = 410
      for (const overrides of [{ website_check_status: 'unknown' }, { website_check_status: undefined },
        { source_card_id: null, source_url: null, website_check_status: 'unknown' },
        { website_check_version: undefined }, { website_check_version: 1 },
        { website_checked_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() },
        { website_checked_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() },
        { website_checked_at: 'not a date' },
        { website_checked_source_url: 'https://2gis.ru/kazan/firm/999' },
        { website_checked_source_url: 'https://2gis.ru/kazan/firm/401/tab/info' }]) {
        const candidate = card(String(index++), overrides)
        assert.equal((await preview([candidate])).to_create, 1)
        assert.equal((await publish([candidate])).created, 1)
      }
    })
    await t.test('three distinct same-name cards are rejected as a whole group', async () => {
      const cards = ['501', '502', '503'].map((id) => card(id, { company_name: 'Сеть' }))
      await assert.rejects(() => preview(cards), /Более двух карточек/)
      await assert.rejects(() => publish(cards), /Более двух карточек/)
      assert.equal((await db.query("select count(*)::integer count from public.leads where company_name = 'Сеть'")).rows[0].count, 0)
    })
    await t.test('site filtering can be disabled without dropping website evidence or deduplication', async () => {
      const cards = [
        card('610', { website: 'https://company.example', website_check_status: 'present' }),
        card('611', { website_check_status: 'present' }),
        card('612', { website_check_status: 'unknown' }),
      ]
      const key = randomUUID()
      const payload = JSON.stringify(cards)
      assert.equal((await db.query(
        'select public.preview_local_import_publication($1, $2, $3::jsonb, 0, false) report',
        [workspaceId, '2gis', payload],
      )).rows[0].report.to_create, 3)
      const publishUnfiltered = async () => (await db.query(
        'select public.publish_local_import_candidates($1, $2, $3, true, $4::jsonb, 0, false) report',
        [workspaceId, '2gis', key, payload],
      )).rows[0].report
      const result = await publishUnfiltered()
      assert.equal(result.created, 3)
      assert.deepEqual(await publishUnfiltered(), result)
      assert.deepEqual((await db.query(
        "select website, website_status from public.leads where import_source_id in ('610','611','612') order by import_source_id",
      )).rows, [
        { website: 'https://company.example', website_status: 'hasWebsite' },
        { website: null, website_status: 'hasWebsite' }, { website: null, website_status: 'unknown' },
      ])
      await db.query('update public.leads set archived_at = now() where id = $1', [result.items[0].lead_id])
      assert.equal((await db.query(
        'select public.preview_local_import_publication($1, $2, $3::jsonb, 0, false) report',
        [workspaceId, '2gis', JSON.stringify([cards[0]])],
      )).rows[0].report.already_exists, 1)
      await assert.rejects(() => publish(cards), /найден сайт/)
    })
    await t.test('stable source IDs and learned aliases protect archived leads, including when their contacts change', async () => {
      const { rows: [manual] } = await db.query(
        "insert into public.leads(workspace_id, company_name, niche, phone, archived_at) values ($1, 'ООО Альба', 'Розница', '8(999)123-00-01', now()) returning id", [workspaceId])
      const matching = card('620', { company_name: 'Альба', phone: '9991230001' })
      assert.equal((await publish([matching])).already_exists, 1)
      await db.query("update public.leads set company_name = 'Другое название', phone = null where id = $1", [manual.id])
      const rediscovered = { ...matching, company_name: 'Альба Новая', phone: '+79999990102', source_url: 'https://2gis.ru/other/firm/620' }
      assert.equal((await preview([rediscovered])).already_exists, 1)
      assert.equal((await publish([rediscovered])).already_exists, 1)
      const original = card('621', { company_name: 'Другой бизнес', phone: '+79999990102' })
      assert.equal((await publish([original])).created, 1, 'A shared phone does not establish company identity')
      const distinctBranch = card('622', { company_name: original.company_name, phone: original.phone,
        address: 'Улица Пушкина, 10' })
      assert.equal((await preview([distinctBranch])).to_create, 1)
      assert.equal((await publish([distinctBranch])).created, 1)
      await db.query("update public.leads set is_deleted = true where import_source_id = '621'")
      assert.equal((await publish([original])).already_exists, 1)
    })
    await t.test('membership checks and private RPC permissions cannot be bypassed', async () => {
      await assert.rejects(() => preview([card('600')], randomUUID()), /Нет доступа/)
      await db.exec('set role authenticated')
      await assert.rejects(() => db.query(
        'select private.publish_local_import_candidates_v1($1, $2, $3, true, $4::jsonb, 0)',
        [workspaceId, '2gis', randomUUID(), JSON.stringify([card('601')])],
      ), /permission denied/)
      assert.equal((await preview([card('602')])).to_create, 1)
      assert.equal((await publish([card('602')])).created, 1)
      await db.exec('reset role')
    })
    await t.test('workflow history and audio survive a database restart with workspace permissions', async () => {
      const team = randomUUID()
      const outsider = randomUUID()
      const teammate = randomUUID()
      await db.query('insert into auth.users values ($1), ($2)', [outsider, teammate])
      await db.query("insert into public.workspaces(id, name, owner_id) values ($1, 'Звонки', $2)", [team, teammate])
      await db.query('insert into public.workspace_members(workspace_id, user_id) values ($1, $2)', [team, teammate])
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [teammate])
      await db.exec('set role authenticated')
      const lead = async (name, status) => (await db.query(
        "insert into public.leads(workspace_id, company_name, niche, status) values ($1, $2, 'Кафе', $3) returning id",
        [team, name, status],
      )).rows[0].id
      const automatic = await lead('Отложенный', 'waiting')
      const manual = await lead('Ручной', 'inProgress')
      const archived = await lead('Отказ и архив', 'rejected')
      const refused = await lead('Отказ по звонку', 'newLead')
      const stats = async () => (await db.query('select public.crm_sales_statistics($1) data', [team])).rows[0].data
      const audio = Buffer.from('524946462600000057415645666d74201000000001000100401f0000803e00000200100064617461020000000000', 'hex')
      const audioCall = randomUUID()
      const resultCall = randomUUID()
      const date = '2026-11-18T10:00:00.000Z'
      const call = (leadId, id, outcome, recording = null) => db.query(
        'select public.save_lead_call($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [leadId, id, date, outcome, 'Доброе начало', 'Долгое ожидание', 'Сохранённые заметки',
          recording ? 'audio/wav' : null, recording ? 1 : null, recording],
      )
      const download = (id) => db.query('select public.get_lead_call_audio($1) data', [id])
      const attach = (recording) => db.query("select public.attach_lead_call_audio($1, 'audio/wav', 1, $2)", [resultCall, recording])
      assert.equal((await stats()).calls_queue, 1)
      await db.query('update public.leads set excluded_from_automatic_calls = true where id = $1', [automatic])
      assert.equal((await stats()).calls_queue, 0)
      assert.equal((await db.query('select status from public.leads where id = $1', [automatic])).rows[0].status, 'waiting')
      await db.query("update public.leads set status = 'newLead' where id = $1", [automatic])
      await db.query("update public.leads set status = 'waiting' where id = $1", [automatic])
      assert.equal((await stats()).calls_queue, 1)
      await db.query("update public.leads set priority = 'high' where id = $1", [refused])
      assert.equal((await stats()).total, 0)
      assert.equal((await stats()).mailing, 0)
      await db.query("update public.leads set priority = 'normal' where id = $1", [refused])
      assert.equal((await stats()).mailing, 1)
      await db.query('update public.leads set manually_queued_for_calls = true where id = $1', [refused])
      assert.equal((await stats()).mailing, 0)
      assert.equal((await stats()).total, 1)
      await db.query('update public.leads set manually_queued_for_calls = false where id = $1', [refused])
      await db.query("update public.leads set manually_queued_for_calls = true where id = $1", [manual])
      await db.query("update public.leads set manually_queued_for_calls = true where id = $1", [manual])
      assert.equal((await stats()).calls_queue, 2)
      await db.query("update public.leads set status = 'offer' where id in ($1,$2)", [automatic, manual])
      assert.equal((await stats()).calls_queue, 1)
      await db.query("update public.leads set archived_at = now() where id = $1", [archived])
      await call(refused, randomUUID(), 'rejected')
      assert.equal((await stats()).rejected_or_hidden, 2)
      await call(manual, randomUUID(), 'interested')
      await call(manual, resultCall, 'interested')
      await call(manual, audioCall, null, audio.toString('base64'))
      await call(manual, audioCall, null, audio.toString('base64'))
      await assert.rejects(() => call(manual, randomUUID(), null, Buffer.alloc(40).toString('base64')), /формату аудио/)
      await assert.rejects(() => call(manual, randomUUID(), null, 'A'.repeat(11184813)), /8 МБ/)
      await attach(audio.toString('base64'))
      await attach(audio.toString('base64'))
      const differentAudio = Buffer.from(audio)
      differentAudio[differentAudio.length - 1] = 1
      await assert.rejects(() => attach(differentAudio.toString('base64')), /уже прикреплена/)
      const messageId = randomUUID()
      await db.exec('reset role')
      for (const [id, kind] of [[messageId, 'telegram_message'], [messageId, 'telegram_message'], [randomUUID(), 'telegram_offer']]) {
        await db.query('select public.log_lead_outreach($1,$2,$3)', [manual, id, kind])
      }
      await db.exec('set role authenticated')
      assert.deepEqual(await stats(), { total: 1, mailing: 1, calls_queue: 1, archived: 1,
        rejected_or_hidden: 2, messaged: 1, offers: 1, waiting: 0, calls_made: 3, interested: 1 })
      await db.close()
      db = new PGlite(directory)
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [teammate])
      await db.exec('set role authenticated')
      assert.equal((await stats()).archived, 1)
      assert.equal((await stats()).calls_queue, 1)
      assert.equal((await db.query('select notes from public.lead_calls where lead_id = $1', [manual])).rows.length, 3)
      for (const id of [audioCall, resultCall]) assert.deepEqual(Buffer.from((await download(id)).rows[0].data, 'base64'), audio)
      await db.query('update public.leads set archived_at = null where id = $1', [archived])
      assert.equal((await stats()).mailing, 1)
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [outsider])
      assert.equal((await stats()).total, 0)
      assert.equal((await download(audioCall)).rows[0].data, null)
      assert.deepEqual((await db.query('select id from public.lead_calls')).rows, [])
      await assert.rejects(() => call(manual, randomUUID(), 'interested'), /Карточка недоступна/)
      await assert.rejects(() => attach(audio.toString('base64')), /Звонок недоступен/)
    })
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }) }
})
