--
-- Name: procrastinate_job_event_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.procrastinate_job_event_type AS ENUM (
    'deferred',
    'started',
    'deferred_for_retry',
    'failed',
    'succeeded',
    'cancelled',
    'abort_requested',
    'aborted',
    'scheduled',
    'retried'
);


--
-- Name: procrastinate_job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.procrastinate_job_status AS ENUM (
    'todo',
    'doing',
    'succeeded',
    'failed',
    'cancelled',
    'aborting',
    'aborted'
);


--
-- Name: procrastinate_job_to_defer_v1; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.procrastinate_job_to_defer_v1 AS (
	queue_name character varying,
	task_name character varying,
	priority integer,
	lock text,
	queueing_lock text,
	args jsonb,
	scheduled_at timestamp with time zone
);


--
-- Name: procrastinate_cancel_job_v1(bigint, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_cancel_job_v1(job_id bigint, abort boolean, delete_job boolean) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    _job_id bigint;
BEGIN
    IF delete_job THEN
        DELETE FROM procrastinate_jobs
        WHERE id = job_id AND status = 'todo'
        RETURNING id INTO _job_id;
    END IF;
    IF _job_id IS NULL THEN
        IF abort THEN
            UPDATE procrastinate_jobs
            SET abort_requested = true,
                status = CASE status
                    WHEN 'todo' THEN 'cancelled'::procrastinate_job_status ELSE status
                END
            WHERE id = job_id AND status IN ('todo', 'doing')
            RETURNING id INTO _job_id;
        ELSE
            UPDATE procrastinate_jobs
            SET status = 'cancelled'::procrastinate_job_status
            WHERE id = job_id AND status = 'todo'
            RETURNING id INTO _job_id;
        END IF;
    END IF;
    RETURN _job_id;
END;
$$;


--
-- Name: procrastinate_defer_jobs_v1(public.procrastinate_job_to_defer_v1[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_defer_jobs_v1(jobs public.procrastinate_job_to_defer_v1[]) RETURNS bigint[]
    LANGUAGE plpgsql
    AS $$
DECLARE
    job_ids bigint[];
BEGIN
    WITH inserted_jobs AS (
        INSERT INTO procrastinate_jobs (queue_name, task_name, priority, lock, queueing_lock, args, scheduled_at)
        SELECT (job).queue_name,
               (job).task_name,
               (job).priority,
               (job).lock,
               (job).queueing_lock,
               (job).args,
               (job).scheduled_at
        FROM unnest(jobs) AS job
        RETURNING id
    )
    SELECT array_agg(id) FROM inserted_jobs INTO job_ids;

    RETURN job_ids;
END;
$$;


--
-- Name: procrastinate_defer_periodic_job_v2(character varying, character varying, character varying, character varying, integer, character varying, bigint, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_defer_periodic_job_v2(_queue_name character varying, _lock character varying, _queueing_lock character varying, _task_name character varying, _priority integer, _periodic_id character varying, _defer_timestamp bigint, _args jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
	_job_id bigint;
	_defer_id bigint;
BEGIN
    INSERT
        INTO procrastinate_periodic_defers (task_name, periodic_id, defer_timestamp)
        VALUES (_task_name, _periodic_id, _defer_timestamp)
        ON CONFLICT DO NOTHING
        RETURNING id into _defer_id;

    IF _defer_id IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE procrastinate_periodic_defers
        SET job_id = (
            SELECT COALESCE((
                SELECT unnest(procrastinate_defer_jobs_v1(
                    ARRAY[
                        ROW(
                            _queue_name,
                            _task_name,
                            _priority,
                            _lock,
                            _queueing_lock,
                            _args,
                            NULL::timestamptz
                        )
                    ]::procrastinate_job_to_defer_v1[]
                ))
            ), NULL)
        )
        WHERE id = _defer_id
        RETURNING job_id INTO _job_id;

    DELETE
        FROM procrastinate_periodic_defers
        USING (
            SELECT id
            FROM procrastinate_periodic_defers
            WHERE procrastinate_periodic_defers.task_name = _task_name
            AND procrastinate_periodic_defers.periodic_id = _periodic_id
            AND procrastinate_periodic_defers.defer_timestamp < _defer_timestamp
            ORDER BY id
            FOR UPDATE
        ) to_delete
        WHERE procrastinate_periodic_defers.id = to_delete.id;

    RETURN _job_id;
END;
$$;


--
-- Name: procrastinate_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procrastinate_jobs (
    id bigint NOT NULL,
    queue_name character varying(128) NOT NULL,
    task_name character varying(128) NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    lock text,
    queueing_lock text,
    args jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.procrastinate_job_status DEFAULT 'todo'::public.procrastinate_job_status NOT NULL,
    scheduled_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    abort_requested boolean DEFAULT false NOT NULL,
    worker_id bigint,
    CONSTRAINT check_not_todo_abort_requested CHECK ((NOT ((status = 'todo'::public.procrastinate_job_status) AND (abort_requested = true))))
);


--
-- Name: procrastinate_fetch_job_v2(character varying[], bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_fetch_job_v2(target_queue_names character varying[], p_worker_id bigint) RETURNS public.procrastinate_jobs
    LANGUAGE plpgsql
    AS $$
DECLARE
	found_jobs procrastinate_jobs;
BEGIN
    WITH candidate AS (
        SELECT jobs.*
            FROM procrastinate_jobs AS jobs
            WHERE
                -- reject the job if its lock has earlier or higher priority jobs
                NOT EXISTS (
                    SELECT 1
                        FROM procrastinate_jobs AS other_jobs
                        WHERE
                            jobs.lock IS NOT NULL
                            AND other_jobs.lock = jobs.lock
                            AND (
                                -- job with same lock is already running
                                other_jobs.status = 'doing'
                                OR
                                -- job with same lock is waiting and has higher priority (or same priority but was queued first)
                                (
                                    other_jobs.status = 'todo'
                                    AND (
                                        other_jobs.priority > jobs.priority
                                        OR (
                                        other_jobs.priority = jobs.priority
                                        AND other_jobs.id < jobs.id
                                        )
                                    )
                                )
                            )
                )
                AND jobs.status = 'todo'
                AND (target_queue_names IS NULL OR jobs.queue_name = ANY( target_queue_names ))
                AND (jobs.scheduled_at IS NULL OR jobs.scheduled_at <= now())
            ORDER BY jobs.priority DESC, jobs.id ASC LIMIT 1
            FOR UPDATE OF jobs SKIP LOCKED
    )
    UPDATE procrastinate_jobs
        SET status = 'doing', worker_id = p_worker_id
        FROM candidate
        WHERE procrastinate_jobs.id = candidate.id
        RETURNING procrastinate_jobs.* INTO found_jobs;

 RETURN found_jobs;
END;
$$;


--
-- Name: procrastinate_finish_job_v1(bigint, public.procrastinate_job_status, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_finish_job_v1(job_id bigint, end_status public.procrastinate_job_status, delete_job boolean) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    _job_id bigint;
BEGIN
    IF end_status NOT IN ('succeeded', 'failed', 'aborted') THEN
        RAISE 'End status should be either "succeeded", "failed" or "aborted" (job id: %)', job_id;
    END IF;
    IF delete_job THEN
        DELETE FROM procrastinate_jobs
        WHERE id = job_id AND status IN ('todo', 'doing')
        RETURNING id INTO _job_id;
    ELSE
        UPDATE procrastinate_jobs
        SET status = end_status,
            abort_requested = false,
            attempts = CASE status
                WHEN 'doing' THEN attempts + 1 ELSE attempts
            END
        WHERE id = job_id AND status IN ('todo', 'doing')
        RETURNING id INTO _job_id;
    END IF;
    IF _job_id IS NULL THEN
        RAISE 'Job was not found or not in "doing" or "todo" status (job id: %)', job_id;
    END IF;
END;
$$;


--
-- Name: procrastinate_notify_queue_abort_job_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_notify_queue_abort_job_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    payload TEXT;
BEGIN
    SELECT json_build_object('type', 'abort_job_requested', 'job_id', NEW.id)::text INTO payload;
	PERFORM pg_notify('procrastinate_queue_v1#' || NEW.queue_name, payload);
	PERFORM pg_notify('procrastinate_any_queue_v1', payload);
	RETURN NEW;
END;
$$;


--
-- Name: procrastinate_notify_queue_job_inserted_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_notify_queue_job_inserted_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    payload TEXT;
BEGIN
    SELECT json_build_object('type', 'job_inserted', 'job_id', NEW.id)::text INTO payload;
	PERFORM pg_notify('procrastinate_queue_v1#' || NEW.queue_name, payload);
	PERFORM pg_notify('procrastinate_any_queue_v1', payload);
	RETURN NEW;
END;
$$;


--
-- Name: procrastinate_prune_stalled_workers_v1(double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_prune_stalled_workers_v1(seconds_since_heartbeat double precision) RETURNS TABLE(worker_id bigint)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    DELETE FROM procrastinate_workers
    WHERE last_heartbeat < NOW() - (seconds_since_heartbeat || 'SECOND')::INTERVAL
    RETURNING procrastinate_workers.id;
END;
$$;


--
-- Name: procrastinate_register_worker_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_register_worker_v1() RETURNS TABLE(worker_id bigint)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    INSERT INTO procrastinate_workers DEFAULT VALUES
    RETURNING procrastinate_workers.id;
END;
$$;


--
-- Name: procrastinate_retry_job_v1(bigint, timestamp with time zone, integer, character varying, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_retry_job_v1(job_id bigint, retry_at timestamp with time zone, new_priority integer, new_queue_name character varying, new_lock character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    _job_id bigint;
    _abort_requested boolean;
BEGIN
    SELECT abort_requested FROM procrastinate_jobs
    WHERE id = job_id AND status = 'doing'
    FOR UPDATE
    INTO _abort_requested;
    IF _abort_requested THEN
        UPDATE procrastinate_jobs
        SET status = 'failed'::procrastinate_job_status
        WHERE id = job_id AND status = 'doing'
        RETURNING id INTO _job_id;
    ELSE
        UPDATE procrastinate_jobs
        SET status = 'todo'::procrastinate_job_status,
            attempts = attempts + 1,
            scheduled_at = retry_at,
            priority = COALESCE(new_priority, priority),
            queue_name = COALESCE(new_queue_name, queue_name),
            lock = COALESCE(new_lock, lock)
        WHERE id = job_id AND status = 'doing'
        RETURNING id INTO _job_id;
    END IF;

    IF _job_id IS NULL THEN
        RAISE 'Job was not found or not in "doing" status (job id: %)', job_id;
    END IF;
END;
$$;


--
-- Name: procrastinate_retry_job_v2(bigint, timestamp with time zone, integer, character varying, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_retry_job_v2(job_id bigint, retry_at timestamp with time zone, new_priority integer, new_queue_name character varying, new_lock character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    _job_id bigint;
    _abort_requested boolean;
    _current_status procrastinate_job_status;
BEGIN
    SELECT status, abort_requested FROM procrastinate_jobs
    WHERE id = job_id AND status IN ('doing', 'failed')
    FOR UPDATE
    INTO _current_status, _abort_requested;
    IF _current_status = 'doing' AND _abort_requested THEN
        UPDATE procrastinate_jobs
        SET status = 'failed'::procrastinate_job_status
        WHERE id = job_id AND status = 'doing'
        RETURNING id INTO _job_id;
    ELSE
        UPDATE procrastinate_jobs
        SET status = 'todo'::procrastinate_job_status,
            attempts = attempts + 1,
            scheduled_at = retry_at,
            priority = COALESCE(new_priority, priority),
            queue_name = COALESCE(new_queue_name, queue_name),
            lock = COALESCE(new_lock, lock)
        WHERE id = job_id AND status IN ('doing', 'failed')
        RETURNING id INTO _job_id;
    END IF;

    IF _job_id IS NULL THEN
        RAISE 'Job was not found or has an invalid status to retry (job id: %)', job_id;
    END IF;

END;
$$;


--
-- Name: procrastinate_trigger_abort_requested_events_procedure_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_trigger_abort_requested_events_procedure_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO procrastinate_events(job_id, type)
        VALUES (NEW.id, 'abort_requested'::procrastinate_job_event_type);
    RETURN NEW;
END;
$$;


--
-- Name: procrastinate_trigger_function_scheduled_events_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_trigger_function_scheduled_events_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO procrastinate_events(job_id, type, at)
        VALUES (NEW.id, 'scheduled'::procrastinate_job_event_type, NEW.scheduled_at);

	RETURN NEW;
END;
$$;


--
-- Name: procrastinate_trigger_function_status_events_insert_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_trigger_function_status_events_insert_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO procrastinate_events(job_id, type)
        VALUES (NEW.id, 'deferred'::procrastinate_job_event_type);
	RETURN NEW;
END;
$$;


--
-- Name: procrastinate_trigger_function_status_events_update_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_trigger_function_status_events_update_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    WITH t AS (
        SELECT CASE
            WHEN OLD.status = 'todo'::procrastinate_job_status
                AND NEW.status = 'doing'::procrastinate_job_status
                THEN 'started'::procrastinate_job_event_type
            WHEN OLD.status = 'doing'::procrastinate_job_status
                AND NEW.status = 'todo'::procrastinate_job_status
                THEN 'deferred_for_retry'::procrastinate_job_event_type
            WHEN OLD.status = 'doing'::procrastinate_job_status
                AND NEW.status = 'failed'::procrastinate_job_status
                THEN 'failed'::procrastinate_job_event_type
            WHEN OLD.status = 'doing'::procrastinate_job_status
                AND NEW.status = 'succeeded'::procrastinate_job_status
                THEN 'succeeded'::procrastinate_job_event_type
            WHEN OLD.status = 'todo'::procrastinate_job_status
                AND (
                    NEW.status = 'cancelled'::procrastinate_job_status
                    OR NEW.status = 'failed'::procrastinate_job_status
                    OR NEW.status = 'succeeded'::procrastinate_job_status
                )
                THEN 'cancelled'::procrastinate_job_event_type
            WHEN OLD.status = 'doing'::procrastinate_job_status
                AND NEW.status = 'aborted'::procrastinate_job_status
                THEN 'aborted'::procrastinate_job_event_type
            WHEN OLD.status = 'failed'::procrastinate_job_status
                AND NEW.status = 'todo'::procrastinate_job_status
                THEN 'retried'::procrastinate_job_event_type
            ELSE NULL
        END as event_type
    )
    INSERT INTO procrastinate_events(job_id, type)
        SELECT NEW.id, t.event_type
        FROM t
        WHERE t.event_type IS NOT NULL;
	RETURN NEW;
END;
$$;


--
-- Name: procrastinate_unlink_periodic_defers_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_unlink_periodic_defers_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE procrastinate_periodic_defers
    SET job_id = NULL
    WHERE job_id = OLD.id;
    RETURN OLD;
END;
$$;


--
-- Name: procrastinate_unregister_worker_v1(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_unregister_worker_v1(worker_id bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM procrastinate_workers
    WHERE id = worker_id;
END;
$$;


--
-- Name: procrastinate_update_heartbeat_v1(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.procrastinate_update_heartbeat_v1(worker_id bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE procrastinate_workers
    SET last_heartbeat = NOW()
    WHERE id = worker_id;
END;
$$;


--
-- Name: agent_previews; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.agent_previews (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    agent_id text NOT NULL,
    version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.api_keys (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    token_hash character varying(64) NOT NULL,
    token_prefix character varying(24) NOT NULL,
    permissions jsonb NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brand_profiles; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.brand_profiles (
    brand text NOT NULL,
    slogan text,
    accent_color text,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT ck_brand_profiles_accent_color CHECK (((accent_color IS NULL) OR (accent_color ~ '^#[0-9a-f]{6}$'::text))),
    CONSTRAINT ck_brand_profiles_brand CHECK ((brand ~ '[^[:space:]]'::text)),
    CONSTRAINT ck_brand_profiles_slogan CHECK (((slogan IS NULL) OR ((btrim(slogan) <> ''::text) AND (char_length(slogan) <= 100))))
);


--
-- Name: brand_templates; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.brand_templates (
    id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    created_by uuid NOT NULL,
    api_key_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    brand text,
    CONSTRAINT ck_brand_templates_brand CHECK (((brand IS NULL) OR (brand ~ '[^[:space:]]'::text))),
    CONSTRAINT ck_brand_templates_kind CHECK ((kind ~ '[^[:space:]]'::text)),
    CONSTRAINT ck_brand_templates_name CHECK ((btrim(name) <> ''::text))
);


--
-- Name: collections; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.collections (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: conversations; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.conversations (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    agent_id text NOT NULL,
    title text NOT NULL,
    title_kind text DEFAULT 'default'::text NOT NULL,
    last_run_id text,
    task_id uuid,
    collection_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    forked_from uuid,
    fork_turn integer,
    completed_at timestamp with time zone,
    same_as uuid,
    CONSTRAINT ck_conversations_fork_pair CHECK ((((forked_from IS NULL) = (fork_turn IS NULL)) AND ((fork_turn IS NULL) OR (fork_turn > 0)))),
    CONSTRAINT ck_conversations_title_kind CHECK ((title_kind = ANY (ARRAY['default'::text, 'generated'::text, 'custom'::text])))
);


--
-- Name: generation_jobs; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.generation_jobs (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    api_key_id uuid,
    conversation_id uuid,
    task_id uuid,
    kind text NOT NULL,
    provider text,
    request jsonb,
    status text NOT NULL,
    provider_task_id text,
    provider_status text,
    error_code text,
    error_message text,
    created_at timestamp with time zone NOT NULL,
    submitted_at timestamp with time zone,
    finished_at timestamp with time zone,
    metadata jsonb,
    root_job_id uuid,
    operation text NOT NULL,
    source_job_id uuid,
    shot_index integer,
    output jsonb
);


--
-- Name: inspiration_videos; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.inspiration_videos (
    video_id text NOT NULL,
    style_raw text NOT NULL,
    style_no text NOT NULL,
    category_id integer NOT NULL,
    category_name text NOT NULL,
    brand_code text NOT NULL,
    brand_name text NOT NULL,
    oss_url text NOT NULL,
    posted_date date,
    impressions bigint NOT NULL,
    views bigint NOT NULL,
    clicks bigint NOT NULL,
    orders bigint NOT NULL,
    revenue numeric NOT NULL
);


--
-- Name: library_entries; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.library_entries (
    id uuid NOT NULL,
    kind text NOT NULL,
    reference_id uuid,
    job_id uuid,
    tag_status text,
    tag_error text,
    tag_started_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: library_entry_tags; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.library_entry_tags (
    entry_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


--
-- Name: library_tags; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.library_tags (
    id uuid NOT NULL,
    parent_id uuid,
    name text NOT NULL,
    auto_fill text,
    guide text,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_accounts; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.oauth_accounts (
    user_id uuid NOT NULL,
    id uuid NOT NULL,
    oauth_name character varying(100) NOT NULL,
    access_token character varying(1024) NOT NULL,
    expires_at integer,
    refresh_token character varying(1024),
    account_id character varying(320) NOT NULL,
    account_email character varying(320) NOT NULL
);


--
-- Name: reference_videos; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.reference_videos (
    id uuid NOT NULL,
    video_url text NOT NULL,
    owner_user_id uuid NOT NULL,
    breakdown_status text NOT NULL,
    error_code text,
    document text,
    version integer DEFAULT 1 NOT NULL,
    requested_by uuid,
    api_key_id uuid,
    started_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT ck_reference_videos_status CHECK ((breakdown_status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: task_assignees; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.task_assignees (
    task_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: tasks; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.tasks (
    id uuid NOT NULL,
    title text NOT NULL,
    status text NOT NULL,
    priority integer NOT NULL,
    deadline timestamp with time zone,
    creator_user_id uuid NOT NULL,
    inputs jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT tasks_inputs_object_check CHECK ((jsonb_typeof(inputs) = 'object'::text)),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'confirmed'::text, 'withdrawn'::text])))
);


--
-- Name: tracking_events; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.tracking_events (
    id uuid NOT NULL,
    name text NOT NULL,
    job_id uuid,
    conversation_id uuid,
    user_id uuid NOT NULL,
    api_key_id uuid,
    occurred_at timestamp with time zone NOT NULL,
    CONSTRAINT ck_tracking_events_subject CHECK (((job_id IS NOT NULL) OR (conversation_id IS NOT NULL)))
);


--
-- Name: users; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.users (
    username character varying(150),
    display_name character varying(255) NOT NULL,
    avatar_url character varying(1024) NOT NULL,
    roles jsonb NOT NULL,
    direct_permissions jsonb NOT NULL,
    city character varying(255) NOT NULL,
    job_title character varying(255) NOT NULL,
    departments jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    id uuid NOT NULL,
    email character varying(320) NOT NULL,
    hashed_password character varying(1024) NOT NULL,
    is_active boolean NOT NULL,
    is_superuser boolean NOT NULL,
    is_verified boolean NOT NULL
);


--
-- Name: video_generation_report; Type: VIEW; Schema: iclip; Owner: -
--

CREATE VIEW iclip.video_generation_report AS
 WITH downloaded AS (
         SELECT DISTINCT tracking_events.job_id AS id
           FROM iclip.tracking_events
          WHERE (tracking_events.name = 'video.downloaded'::text)
        ), with_source AS (
         SELECT downloaded.id
           FROM downloaded
        UNION
         SELECT g_1.source_job_id
           FROM (downloaded d
             JOIN iclip.generation_jobs g_1 ON ((g_1.id = d.id)))
          WHERE (g_1.operation = 'enhance'::text)
        ), with_film AS (
         SELECT with_source.id
           FROM with_source
        UNION
         SELECT ((v.value ->> 'jobId'::text))::uuid AS uuid
           FROM ((with_source w
             JOIN iclip.generation_jobs g_1 ON (((g_1.id = w.id) AND (g_1.kind = 'whole_film'::text))))
             CROSS JOIN LATERAL jsonb_array_elements((g_1.request -> 'videos'::text)) v(value))
        ), credited AS (
         SELECT with_film.id
           FROM with_film
        UNION
         SELECT g_1.root_job_id
           FROM (with_film w
             JOIN iclip.generation_jobs g_1 ON ((g_1.id = w.id)))
          WHERE (g_1.root_job_id IS NOT NULL)
        )
 SELECT u.email AS user_email,
    u.username AS user_name,
    g.id AS job_id,
    (g.created_at AT TIME ZONE 'Asia/Shanghai'::text) AS started_at,
    (g.finished_at AT TIME ZONE 'Asia/Shanghai'::text) AS finished_at,
    (g.request ->> 'model'::text) AS model,
        CASE g.status
            WHEN 'completed'::text THEN '成功'::text
            ELSE '失败'::text
        END AS status,
    (c.id IS NOT NULL) AS downloaded
   FROM ((iclip.generation_jobs g
     JOIN iclip.users u ON ((u.id = g.owner_user_id)))
     LEFT JOIN credited c ON ((c.id = g.id)))
  WHERE ((g.kind = 'video'::text) AND (g.operation = 'generate'::text) AND (g.source_job_id IS NULL) AND (g.status = ANY (ARRAY['completed'::text, 'failed'::text])));


--
-- Name: whole_film_drafts; Type: TABLE; Schema: iclip; Owner: -
--

CREATE TABLE iclip.whole_film_drafts (
    conversation_id uuid NOT NULL,
    document jsonb NOT NULL,
    revision integer NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT ck_whole_film_drafts_document CHECK ((jsonb_typeof(document) = 'object'::text)),
    CONSTRAINT ck_whole_film_drafts_revision CHECK ((revision >= 1))
);


--
-- Name: procrastinate_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procrastinate_events (
    id bigint NOT NULL,
    job_id bigint NOT NULL,
    type public.procrastinate_job_event_type,
    at timestamp with time zone DEFAULT now()
);


--
-- Name: procrastinate_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.procrastinate_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: procrastinate_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.procrastinate_events_id_seq OWNED BY public.procrastinate_events.id;


--
-- Name: procrastinate_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.procrastinate_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: procrastinate_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.procrastinate_jobs_id_seq OWNED BY public.procrastinate_jobs.id;


--
-- Name: procrastinate_periodic_defers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procrastinate_periodic_defers (
    id bigint NOT NULL,
    task_name character varying(128) NOT NULL,
    defer_timestamp bigint,
    job_id bigint,
    periodic_id character varying(128) DEFAULT ''::character varying NOT NULL
);


--
-- Name: procrastinate_periodic_defers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.procrastinate_periodic_defers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: procrastinate_periodic_defers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.procrastinate_periodic_defers_id_seq OWNED BY public.procrastinate_periodic_defers.id;


--
-- Name: procrastinate_workers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procrastinate_workers (
    id bigint NOT NULL,
    last_heartbeat timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: procrastinate_workers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.procrastinate_workers ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.procrastinate_workers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: procrastinate_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procrastinate_events ALTER COLUMN id SET DEFAULT nextval('public.procrastinate_events_id_seq'::regclass);


--
-- Name: procrastinate_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procrastinate_jobs ALTER COLUMN id SET DEFAULT nextval('public.procrastinate_jobs_id_seq'::regclass);


--
-- Name: procrastinate_periodic_defers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procrastinate_periodic_defers ALTER COLUMN id SET DEFAULT nextval('public.procrastinate_periodic_defers_id_seq'::regclass);


--
-- Name: agent_previews agent_previews_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.agent_previews
    ADD CONSTRAINT agent_previews_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: brand_profiles brand_profiles_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.brand_profiles
    ADD CONSTRAINT brand_profiles_pkey PRIMARY KEY (brand);


--
-- Name: brand_templates brand_templates_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.brand_templates
    ADD CONSTRAINT brand_templates_pkey PRIMARY KEY (id);


--
-- Name: collections collections_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.collections
    ADD CONSTRAINT collections_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: generation_jobs generation_jobs_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.generation_jobs
    ADD CONSTRAINT generation_jobs_pkey PRIMARY KEY (id);


--
-- Name: inspiration_videos inspiration_videos_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.inspiration_videos
    ADD CONSTRAINT inspiration_videos_pkey PRIMARY KEY (video_id);


--
-- Name: library_entries library_entries_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.library_entries
    ADD CONSTRAINT library_entries_pkey PRIMARY KEY (id);


--
-- Name: library_entry_tags library_entry_tags_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.library_entry_tags
    ADD CONSTRAINT library_entry_tags_pkey PRIMARY KEY (entry_id, tag_id);


--
-- Name: library_tags library_tags_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.library_tags
    ADD CONSTRAINT library_tags_pkey PRIMARY KEY (id);


--
-- Name: oauth_accounts oauth_accounts_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.oauth_accounts
    ADD CONSTRAINT oauth_accounts_pkey PRIMARY KEY (id);


--
-- Name: reference_videos reference_videos_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.reference_videos
    ADD CONSTRAINT reference_videos_pkey PRIMARY KEY (id);


--
-- Name: task_assignees task_assignees_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.task_assignees
    ADD CONSTRAINT task_assignees_pkey PRIMARY KEY (task_id, user_id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: tracking_events tracking_events_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.tracking_events
    ADD CONSTRAINT tracking_events_pkey PRIMARY KEY (id);


--
-- Name: agent_previews uq_agent_previews_owner_agent; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.agent_previews
    ADD CONSTRAINT uq_agent_previews_owner_agent UNIQUE (owner_user_id, agent_id);


--
-- Name: library_tags uq_library_tags_parent_name; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.library_tags
    ADD CONSTRAINT uq_library_tags_parent_name UNIQUE (parent_id, name);


--
-- Name: reference_videos uq_reference_videos_video_url; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.reference_videos
    ADD CONSTRAINT uq_reference_videos_video_url UNIQUE (video_url);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: whole_film_drafts whole_film_drafts_pkey; Type: CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.whole_film_drafts
    ADD CONSTRAINT whole_film_drafts_pkey PRIMARY KEY (conversation_id);


--
-- Name: procrastinate_events procrastinate_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procrastinate_events
    ADD CONSTRAINT procrastinate_events_pkey PRIMARY KEY (id);


--
-- Name: procrastinate_jobs procrastinate_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procrastinate_jobs
    ADD CONSTRAINT procrastinate_jobs_pkey PRIMARY KEY (id);


--
-- Name: procrastinate_periodic_defers procrastinate_periodic_defers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procrastinate_periodic_defers
    ADD CONSTRAINT procrastinate_periodic_defers_pkey PRIMARY KEY (id);


--
-- Name: procrastinate_periodic_defers procrastinate_periodic_defers_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procrastinate_periodic_defers
    ADD CONSTRAINT procrastinate_periodic_defers_unique UNIQUE (task_name, periodic_id, defer_timestamp);


--
-- Name: procrastinate_workers procrastinate_workers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procrastinate_workers
    ADD CONSTRAINT procrastinate_workers_pkey PRIMARY KEY (id);


--
-- Name: ix_collections_created; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_collections_created ON iclip.collections USING btree (created_at DESC, id DESC);


--
-- Name: ix_collections_owner_created; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_collections_owner_created ON iclip.collections USING btree (owner_user_id, created_at DESC, id DESC);


--
-- Name: ix_conversations_collection; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_conversations_collection ON iclip.conversations USING btree (collection_id, created_at DESC, id DESC) WHERE ((collection_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: ix_conversations_created; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_conversations_created ON iclip.conversations USING btree (created_at DESC, id DESC);


--
-- Name: ix_conversations_owner_created; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_conversations_owner_created ON iclip.conversations USING btree (owner_user_id, created_at DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: ix_conversations_task; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_conversations_task ON iclip.conversations USING btree (task_id, created_at) WHERE ((task_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: ix_conversations_updated; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_conversations_updated ON iclip.conversations USING btree (updated_at DESC, id DESC);


--
-- Name: ix_generation_jobs_conversation_kind_created; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_conversation_kind_created ON iclip.generation_jobs USING btree (conversation_id, kind, created_at, id) WHERE (conversation_id IS NOT NULL);


--
-- Name: ix_generation_jobs_conversation_shot; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_conversation_shot ON iclip.generation_jobs USING btree (conversation_id, shot_index) WHERE ((kind = 'video'::text) AND (shot_index IS NOT NULL));


--
-- Name: ix_generation_jobs_masters; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_masters ON iclip.generation_jobs USING btree (conversation_id, finished_at, id) WHERE ((kind = 'video'::text) AND (status = 'completed'::text) AND ((output ->> 'url'::text) IS NOT NULL) AND (((operation = 'generate'::text) AND (source_job_id IS NULL)) OR (operation = 'compose'::text)));


--
-- Name: ix_generation_jobs_output_url; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_output_url ON iclip.generation_jobs USING hash (((output ->> 'url'::text))) WHERE ((output ->> 'url'::text) IS NOT NULL);


--
-- Name: ix_generation_jobs_owner_created; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_owner_created ON iclip.generation_jobs USING btree (owner_user_id, created_at, id);


--
-- Name: ix_generation_jobs_reference_trial; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_reference_trial ON iclip.generation_jobs USING btree (((metadata ->> 'referenceId'::text)), created_at) WHERE ((metadata ->> 'referenceId'::text) IS NOT NULL);


--
-- Name: ix_generation_jobs_root_job; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_root_job ON iclip.generation_jobs USING btree (root_job_id) WHERE (root_job_id IS NOT NULL);


--
-- Name: ix_generation_jobs_source_job; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_source_job ON iclip.generation_jobs USING btree (source_job_id) WHERE (source_job_id IS NOT NULL);


--
-- Name: ix_generation_jobs_task_created; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_task_created ON iclip.generation_jobs USING btree (task_id, created_at, id) WHERE (task_id IS NOT NULL);


--
-- Name: ix_generation_jobs_unfinished; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_unfinished ON iclip.generation_jobs USING btree (conversation_id, kind) WHERE (status = ANY (ARRAY['pending'::text, 'submitting'::text, 'submitted'::text]));


--
-- Name: ix_generation_jobs_video_upload_md5; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_video_upload_md5 ON iclip.generation_jobs USING btree (((output ->> 'content_md5'::text)), created_at, id) WHERE ((kind = 'video'::text) AND (operation = 'upload'::text));


--
-- Name: ix_generation_jobs_whole_films; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_generation_jobs_whole_films ON iclip.generation_jobs USING btree (conversation_id, finished_at, id) WHERE ((kind = 'whole_film'::text) AND (status = 'completed'::text) AND ((output ->> 'url'::text) IS NOT NULL));


--
-- Name: ix_iclip_api_keys_owner_user_id; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_iclip_api_keys_owner_user_id ON iclip.api_keys USING btree (owner_user_id);


--
-- Name: ix_iclip_api_keys_token_hash; Type: INDEX; Schema: iclip; Owner: -
--

CREATE UNIQUE INDEX ix_iclip_api_keys_token_hash ON iclip.api_keys USING btree (token_hash);


--
-- Name: ix_iclip_oauth_accounts_account_id; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_iclip_oauth_accounts_account_id ON iclip.oauth_accounts USING btree (account_id);


--
-- Name: ix_iclip_oauth_accounts_oauth_name; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_iclip_oauth_accounts_oauth_name ON iclip.oauth_accounts USING btree (oauth_name);


--
-- Name: ix_iclip_oauth_accounts_user_id; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_iclip_oauth_accounts_user_id ON iclip.oauth_accounts USING btree (user_id);


--
-- Name: ix_iclip_users_email; Type: INDEX; Schema: iclip; Owner: -
--

CREATE UNIQUE INDEX ix_iclip_users_email ON iclip.users USING btree (email);


--
-- Name: ix_inspiration_videos_category_brand; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_inspiration_videos_category_brand ON iclip.inspiration_videos USING btree (category_id, brand_code);


--
-- Name: ix_inspiration_videos_style_no; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_inspiration_videos_style_no ON iclip.inspiration_videos USING btree (style_no);


--
-- Name: ix_library_entry_tags_tag; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_library_entry_tags_tag ON iclip.library_entry_tags USING btree (tag_id);


--
-- Name: ix_reference_videos_listed; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_reference_videos_listed ON iclip.reference_videos USING btree (created_at DESC, id) WHERE (deleted_at IS NULL);


--
-- Name: ix_task_assignees_user; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_task_assignees_user ON iclip.task_assignees USING btree (user_id);


--
-- Name: ix_tasks_created; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_tasks_created ON iclip.tasks USING btree (created_at DESC, id DESC);


--
-- Name: ix_tracking_events_conversation; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_tracking_events_conversation ON iclip.tracking_events USING btree (conversation_id, occurred_at);


--
-- Name: ix_tracking_events_job; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_tracking_events_job ON iclip.tracking_events USING btree (job_id);


--
-- Name: ix_tracking_events_name; Type: INDEX; Schema: iclip; Owner: -
--

CREATE INDEX ix_tracking_events_name ON iclip.tracking_events USING btree (name, occurred_at);


--
-- Name: uq_library_entries_job; Type: INDEX; Schema: iclip; Owner: -
--

CREATE UNIQUE INDEX uq_library_entries_job ON iclip.library_entries USING btree (kind, job_id) WHERE (job_id IS NOT NULL);


--
-- Name: uq_library_entries_reference; Type: INDEX; Schema: iclip; Owner: -
--

CREATE UNIQUE INDEX uq_library_entries_reference ON iclip.library_entries USING btree (kind, reference_id) WHERE (reference_id IS NOT NULL);


--
-- Name: uq_library_tags_dimension_name; Type: INDEX; Schema: iclip; Owner: -
--

CREATE UNIQUE INDEX uq_library_tags_dimension_name ON iclip.library_tags USING btree (name) WHERE (parent_id IS NULL);


--
-- Name: idx_procrastinate_jobs_worker_not_null; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_procrastinate_jobs_worker_not_null ON public.procrastinate_jobs USING btree (worker_id) WHERE ((worker_id IS NOT NULL) AND (status = 'doing'::public.procrastinate_job_status));


--
-- Name: idx_procrastinate_workers_last_heartbeat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_procrastinate_workers_last_heartbeat ON public.procrastinate_workers USING btree (last_heartbeat);


--
-- Name: procrastinate_events_job_id_fkey_v1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX procrastinate_events_job_id_fkey_v1 ON public.procrastinate_events USING btree (job_id);


--
-- Name: procrastinate_jobs_id_lock_idx_v1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX procrastinate_jobs_id_lock_idx_v1 ON public.procrastinate_jobs USING btree (id, lock) WHERE (status = ANY (ARRAY['todo'::public.procrastinate_job_status, 'doing'::public.procrastinate_job_status]));


--
-- Name: procrastinate_jobs_lock_idx_v1; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX procrastinate_jobs_lock_idx_v1 ON public.procrastinate_jobs USING btree (lock) WHERE (status = 'doing'::public.procrastinate_job_status);


--
-- Name: procrastinate_jobs_priority_idx_v1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX procrastinate_jobs_priority_idx_v1 ON public.procrastinate_jobs USING btree (priority DESC, id) WHERE (status = 'todo'::public.procrastinate_job_status);


--
-- Name: procrastinate_jobs_queue_name_idx_v1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX procrastinate_jobs_queue_name_idx_v1 ON public.procrastinate_jobs USING btree (queue_name);


--
-- Name: procrastinate_jobs_queueing_lock_idx_v1; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX procrastinate_jobs_queueing_lock_idx_v1 ON public.procrastinate_jobs USING btree (queueing_lock) WHERE (status = 'todo'::public.procrastinate_job_status);


--
-- Name: procrastinate_periodic_defers_job_id_fkey_v1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX procrastinate_periodic_defers_job_id_fkey_v1 ON public.procrastinate_periodic_defers USING btree (job_id);


--
-- Name: procrastinate_jobs procrastinate_jobs_notify_queue_job_aborted_v1; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER procrastinate_jobs_notify_queue_job_aborted_v1 AFTER UPDATE OF abort_requested ON public.procrastinate_jobs FOR EACH ROW WHEN (((old.abort_requested = false) AND (new.abort_requested = true) AND (new.status = 'doing'::public.procrastinate_job_status))) EXECUTE FUNCTION public.procrastinate_notify_queue_abort_job_v1();


--
-- Name: procrastinate_jobs procrastinate_jobs_notify_queue_job_inserted_v1; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER procrastinate_jobs_notify_queue_job_inserted_v1 AFTER INSERT ON public.procrastinate_jobs FOR EACH ROW WHEN ((new.status = 'todo'::public.procrastinate_job_status)) EXECUTE FUNCTION public.procrastinate_notify_queue_job_inserted_v1();


--
-- Name: procrastinate_jobs procrastinate_trigger_abort_requested_events_v1; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER procrastinate_trigger_abort_requested_events_v1 AFTER UPDATE OF abort_requested ON public.procrastinate_jobs FOR EACH ROW WHEN ((new.abort_requested = true)) EXECUTE FUNCTION public.procrastinate_trigger_abort_requested_events_procedure_v1();


--
-- Name: procrastinate_jobs procrastinate_trigger_delete_jobs_v1; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER procrastinate_trigger_delete_jobs_v1 BEFORE DELETE ON public.procrastinate_jobs FOR EACH ROW EXECUTE FUNCTION public.procrastinate_unlink_periodic_defers_v1();


--
-- Name: procrastinate_jobs procrastinate_trigger_scheduled_events_v1; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER procrastinate_trigger_scheduled_events_v1 AFTER INSERT OR UPDATE ON public.procrastinate_jobs FOR EACH ROW WHEN (((new.scheduled_at IS NOT NULL) AND (new.status = 'todo'::public.procrastinate_job_status))) EXECUTE FUNCTION public.procrastinate_trigger_function_scheduled_events_v1();


--
-- Name: procrastinate_jobs procrastinate_trigger_status_events_insert_v1; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER procrastinate_trigger_status_events_insert_v1 AFTER INSERT ON public.procrastinate_jobs FOR EACH ROW WHEN ((new.status = 'todo'::public.procrastinate_job_status)) EXECUTE FUNCTION public.procrastinate_trigger_function_status_events_insert_v1();


--
-- Name: procrastinate_jobs procrastinate_trigger_status_events_update_v1; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER procrastinate_trigger_status_events_update_v1 AFTER UPDATE OF status ON public.procrastinate_jobs FOR EACH ROW EXECUTE FUNCTION public.procrastinate_trigger_function_status_events_update_v1();


--
-- Name: api_keys api_keys_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.api_keys
    ADD CONSTRAINT api_keys_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES iclip.users(id) ON DELETE CASCADE;


--
-- Name: collections collections_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.collections
    ADD CONSTRAINT collections_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES iclip.users(id) ON DELETE RESTRICT;


--
-- Name: conversations conversations_collection_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.conversations
    ADD CONSTRAINT conversations_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES iclip.collections(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.conversations
    ADD CONSTRAINT conversations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES iclip.users(id) ON DELETE RESTRICT;


--
-- Name: conversations conversations_task_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.conversations
    ADD CONSTRAINT conversations_task_id_fkey FOREIGN KEY (task_id) REFERENCES iclip.tasks(id) ON DELETE SET NULL;


--
-- Name: agent_previews fk_agent_previews_owner; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.agent_previews
    ADD CONSTRAINT fk_agent_previews_owner FOREIGN KEY (owner_user_id) REFERENCES iclip.users(id) ON DELETE CASCADE;


--
-- Name: brand_profiles fk_brand_profiles_updated_by; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.brand_profiles
    ADD CONSTRAINT fk_brand_profiles_updated_by FOREIGN KEY (updated_by) REFERENCES iclip.users(id);


--
-- Name: brand_templates fk_brand_templates_created_by; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.brand_templates
    ADD CONSTRAINT fk_brand_templates_created_by FOREIGN KEY (created_by) REFERENCES iclip.users(id);


--
-- Name: conversations fk_conversations_forked_from; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.conversations
    ADD CONSTRAINT fk_conversations_forked_from FOREIGN KEY (forked_from) REFERENCES iclip.conversations(id) ON DELETE RESTRICT;


--
-- Name: conversations fk_conversations_same_as; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.conversations
    ADD CONSTRAINT fk_conversations_same_as FOREIGN KEY (same_as) REFERENCES iclip.conversations(id) ON DELETE SET NULL;


--
-- Name: generation_jobs fk_generation_jobs_root_job; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.generation_jobs
    ADD CONSTRAINT fk_generation_jobs_root_job FOREIGN KEY (root_job_id) REFERENCES iclip.generation_jobs(id);


--
-- Name: generation_jobs fk_generation_jobs_source_job; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.generation_jobs
    ADD CONSTRAINT fk_generation_jobs_source_job FOREIGN KEY (source_job_id) REFERENCES iclip.generation_jobs(id);


--
-- Name: reference_videos fk_reference_videos_owner; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.reference_videos
    ADD CONSTRAINT fk_reference_videos_owner FOREIGN KEY (owner_user_id) REFERENCES iclip.users(id);


--
-- Name: tracking_events fk_tracking_events_job; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.tracking_events
    ADD CONSTRAINT fk_tracking_events_job FOREIGN KEY (job_id) REFERENCES iclip.generation_jobs(id);


--
-- Name: tracking_events fk_tracking_events_user; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.tracking_events
    ADD CONSTRAINT fk_tracking_events_user FOREIGN KEY (user_id) REFERENCES iclip.users(id) ON DELETE CASCADE;


--
-- Name: whole_film_drafts fk_whole_film_drafts_conversation; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.whole_film_drafts
    ADD CONSTRAINT fk_whole_film_drafts_conversation FOREIGN KEY (conversation_id) REFERENCES iclip.conversations(id);


--
-- Name: whole_film_drafts fk_whole_film_drafts_updated_by; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.whole_film_drafts
    ADD CONSTRAINT fk_whole_film_drafts_updated_by FOREIGN KEY (updated_by) REFERENCES iclip.users(id);


--
-- Name: generation_jobs generation_jobs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.generation_jobs
    ADD CONSTRAINT generation_jobs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES iclip.users(id) ON DELETE CASCADE;


--
-- Name: library_entries library_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.library_entries
    ADD CONSTRAINT library_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES iclip.users(id);


--
-- Name: library_entries library_entries_job_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.library_entries
    ADD CONSTRAINT library_entries_job_id_fkey FOREIGN KEY (job_id) REFERENCES iclip.generation_jobs(id) ON DELETE CASCADE;


--
-- Name: library_entries library_entries_reference_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.library_entries
    ADD CONSTRAINT library_entries_reference_id_fkey FOREIGN KEY (reference_id) REFERENCES iclip.reference_videos(id) ON DELETE CASCADE;


--
-- Name: library_entry_tags library_entry_tags_entry_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.library_entry_tags
    ADD CONSTRAINT library_entry_tags_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES iclip.library_entries(id) ON DELETE CASCADE;


--
-- Name: library_entry_tags library_entry_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.library_entry_tags
    ADD CONSTRAINT library_entry_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES iclip.library_tags(id) ON DELETE CASCADE;


--
-- Name: library_tags library_tags_parent_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.library_tags
    ADD CONSTRAINT library_tags_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES iclip.library_tags(id) ON DELETE CASCADE;


--
-- Name: oauth_accounts oauth_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.oauth_accounts
    ADD CONSTRAINT oauth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES iclip.users(id) ON DELETE CASCADE;


--
-- Name: task_assignees task_assignees_task_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.task_assignees
    ADD CONSTRAINT task_assignees_task_id_fkey FOREIGN KEY (task_id) REFERENCES iclip.tasks(id) ON DELETE CASCADE;


--
-- Name: task_assignees task_assignees_user_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.task_assignees
    ADD CONSTRAINT task_assignees_user_id_fkey FOREIGN KEY (user_id) REFERENCES iclip.users(id) ON DELETE RESTRICT;


--
-- Name: tasks tasks_creator_user_id_fkey; Type: FK CONSTRAINT; Schema: iclip; Owner: -
--

ALTER TABLE ONLY iclip.tasks
    ADD CONSTRAINT tasks_creator_user_id_fkey FOREIGN KEY (creator_user_id) REFERENCES iclip.users(id) ON DELETE RESTRICT;


--
-- Name: procrastinate_events procrastinate_events_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procrastinate_events
    ADD CONSTRAINT procrastinate_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.procrastinate_jobs(id) ON DELETE CASCADE;


--
-- Name: procrastinate_jobs procrastinate_jobs_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procrastinate_jobs
    ADD CONSTRAINT procrastinate_jobs_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.procrastinate_workers(id) ON DELETE SET NULL;


--
-- Name: procrastinate_periodic_defers procrastinate_periodic_defers_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procrastinate_periodic_defers
    ADD CONSTRAINT procrastinate_periodic_defers_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.procrastinate_jobs(id);



