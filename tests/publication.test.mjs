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
  create table auth.users (id uuid primary key);
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
      for (const [id, kind] of [[messageId, 'telegram_message'], [messageId, 'telegram_message'], [randomUUID(), 'telegram_offer']]) {
        await db.query('select public.log_lead_outreach($1,$2,$3)', [manual, id, kind])
      }
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
