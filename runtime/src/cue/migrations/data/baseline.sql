--
-- Name: agent_drafts; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.agent_drafts (
    agent_id text NOT NULL,
    config jsonb NOT NULL,
    base_version_id uuid,
    lock_version integer NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_job_runs; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.agent_job_runs (
    run_id text NOT NULL,
    prompt_id text NOT NULL,
    started_at timestamp with time zone NOT NULL
);


--
-- Name: agent_jobs; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.agent_jobs (
    prompt_id text NOT NULL,
    conversation_id text NOT NULL,
    agent_id text NOT NULL,
    owner_user_id uuid NOT NULL,
    user_name text NOT NULL,
    content text NOT NULL,
    status text NOT NULL,
    run_id text,
    created_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    steered_at timestamp with time zone,
    locked_by text,
    heartbeat_at timestamp with time zone,
    interrupt_reason text,
    attempt integer DEFAULT 0 NOT NULL,
    decisions text
);


--
-- Name: agent_revisions; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.agent_revisions (
    id uuid NOT NULL,
    agent_id text NOT NULL,
    operation text NOT NULL,
    from_version_id uuid,
    to_version_id uuid,
    actor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_skill_bindings; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.agent_skill_bindings (
    agent_id text NOT NULL,
    skill_id uuid NOT NULL,
    priority integer NOT NULL
);


--
-- Name: agent_version_skills; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.agent_version_skills (
    version_id uuid NOT NULL,
    skill_id uuid NOT NULL,
    priority integer NOT NULL
);


--
-- Name: agent_versions; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.agent_versions (
    id uuid NOT NULL,
    agent_id text NOT NULL,
    version integer NOT NULL,
    config jsonb NOT NULL,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agents; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.agents (
    id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    status text NOT NULL,
    listed boolean NOT NULL,
    sort_order integer NOT NULL,
    active_version_id uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversation_usage; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.conversation_usage (
    conversation_id text NOT NULL,
    model_name text NOT NULL,
    requests bigint NOT NULL,
    input_tokens bigint NOT NULL,
    cache_read_tokens bigint NOT NULL,
    cache_write_tokens bigint NOT NULL,
    output_tokens bigint NOT NULL,
    first_at timestamp with time zone NOT NULL,
    last_at timestamp with time zone NOT NULL
);


--
-- Name: default_models; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.default_models (
    type text NOT NULL,
    provider_id uuid NOT NULL,
    model_name text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.events (
    seq bigint NOT NULL,
    run_id text NOT NULL,
    kind text NOT NULL,
    step_index integer NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    conversation_id text,
    parent_run_id text,
    agent_name text,
    tool_call_id text,
    tool_name text,
    error text,
    metadata text NOT NULL,
    idempotency_key text
);


--
-- Name: events_seq_seq; Type: SEQUENCE; Schema: agent_runtime; Owner: -
--

ALTER TABLE agent_runtime.events ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME agent_runtime.events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mcp_servers; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.mcp_servers (
    id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    url text NOT NULL,
    transport text NOT NULL,
    timeout_seconds integer NOT NULL,
    headers jsonb NOT NULL,
    enabled boolean NOT NULL,
    check_ok boolean,
    check_elapsed_ms integer,
    check_reason text,
    checked_at timestamp with time zone,
    tools jsonb,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    url_hash text NOT NULL
);


--
-- Name: media; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.media (
    sha256 text NOT NULL,
    media_type text,
    bytes bytea NOT NULL,
    size_bytes bigint NOT NULL,
    metadata text
);


--
-- Name: model_providers; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.model_providers (
    id uuid NOT NULL,
    name text NOT NULL,
    provider text NOT NULL,
    label text NOT NULL,
    default_credential_id uuid,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_credentials; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.provider_credentials (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    name text NOT NULL,
    fields jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_models; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.provider_models (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    source text NOT NULL,
    properties jsonb,
    enabled boolean NOT NULL
);


--
-- Name: runs; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.runs (
    run_id text NOT NULL,
    conversation_id text,
    parent_run_id text,
    agent_name text,
    metadata text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    registration_id text
);


--
-- Name: sessions; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.sessions (
    id uuid NOT NULL,
    agent_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    app_id text NOT NULL,
    preview_agent_id text
);


--
-- Name: skill_draft_files; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.skill_draft_files (
    skill_id uuid NOT NULL,
    path text NOT NULL,
    content text NOT NULL,
    size integer NOT NULL,
    hash text NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: skill_version_files; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.skill_version_files (
    version_id uuid NOT NULL,
    path text NOT NULL,
    content text NOT NULL
);


--
-- Name: skill_versions; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.skill_versions (
    id uuid NOT NULL,
    skill_id uuid NOT NULL,
    version integer NOT NULL,
    note text,
    manifest jsonb NOT NULL,
    content_hash text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: skills; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.skills (
    id uuid NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    description text NOT NULL,
    latest_version_id uuid,
    status text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: snapshot_idempotency_keys; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.snapshot_idempotency_keys (
    run_id text NOT NULL,
    idempotency_key text NOT NULL
);


--
-- Name: snapshot_messages; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.snapshot_messages (
    sha256 text NOT NULL,
    message text NOT NULL
);


--
-- Name: snapshots; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.snapshots (
    seq bigint NOT NULL,
    run_id text NOT NULL,
    step_index integer NOT NULL,
    conversation_id text,
    parent_run_id text,
    agent_name text,
    "timestamp" timestamp with time zone NOT NULL,
    state text DEFAULT 'complete'::text NOT NULL,
    messages text NOT NULL,
    idempotency_key text
);


--
-- Name: snapshots_seq_seq; Type: SEQUENCE; Schema: agent_runtime; Owner: -
--

ALTER TABLE agent_runtime.snapshots ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME agent_runtime.snapshots_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tool_effects; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.tool_effects (
    run_id text NOT NULL,
    tool_call_id text NOT NULL,
    tool_name text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    idempotency_key text,
    effect_summary text
);


--
-- Name: workspace_files; Type: TABLE; Schema: agent_runtime; Owner: -
--

CREATE TABLE agent_runtime.workspace_files (
    namespace text NOT NULL,
    path text NOT NULL,
    content text NOT NULL,
    size_bytes bigint GENERATED ALWAYS AS (octet_length(content)) STORED NOT NULL,
    version bigint NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: agent_drafts agent_drafts_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_drafts
    ADD CONSTRAINT agent_drafts_pkey PRIMARY KEY (agent_id);


--
-- Name: agent_job_runs agent_job_runs_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_job_runs
    ADD CONSTRAINT agent_job_runs_pkey PRIMARY KEY (run_id);


--
-- Name: agent_jobs agent_jobs_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_jobs
    ADD CONSTRAINT agent_jobs_pkey PRIMARY KEY (prompt_id);


--
-- Name: agent_revisions agent_revisions_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_revisions
    ADD CONSTRAINT agent_revisions_pkey PRIMARY KEY (id);


--
-- Name: agent_skill_bindings agent_skill_bindings_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_skill_bindings
    ADD CONSTRAINT agent_skill_bindings_pkey PRIMARY KEY (agent_id, skill_id);


--
-- Name: agent_version_skills agent_version_skills_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_version_skills
    ADD CONSTRAINT agent_version_skills_pkey PRIMARY KEY (version_id, skill_id);


--
-- Name: agent_versions agent_versions_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_versions
    ADD CONSTRAINT agent_versions_pkey PRIMARY KEY (id);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: conversation_usage conversation_usage_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.conversation_usage
    ADD CONSTRAINT conversation_usage_pkey PRIMARY KEY (conversation_id, model_name);


--
-- Name: default_models default_models_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.default_models
    ADD CONSTRAINT default_models_pkey PRIMARY KEY (type);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (seq);


--
-- Name: mcp_servers mcp_servers_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (id);


--
-- Name: media media_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.media
    ADD CONSTRAINT media_pkey PRIMARY KEY (sha256);


--
-- Name: model_providers model_providers_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.model_providers
    ADD CONSTRAINT model_providers_pkey PRIMARY KEY (id);


--
-- Name: provider_credentials provider_credentials_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.provider_credentials
    ADD CONSTRAINT provider_credentials_pkey PRIMARY KEY (id);


--
-- Name: provider_models provider_models_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.provider_models
    ADD CONSTRAINT provider_models_pkey PRIMARY KEY (id);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (run_id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: skill_draft_files skill_draft_files_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.skill_draft_files
    ADD CONSTRAINT skill_draft_files_pkey PRIMARY KEY (skill_id, path);


--
-- Name: skill_version_files skill_version_files_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.skill_version_files
    ADD CONSTRAINT skill_version_files_pkey PRIMARY KEY (version_id, path);


--
-- Name: skill_versions skill_versions_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.skill_versions
    ADD CONSTRAINT skill_versions_pkey PRIMARY KEY (id);


--
-- Name: skills skills_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);


--
-- Name: snapshot_idempotency_keys snapshot_idempotency_keys_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.snapshot_idempotency_keys
    ADD CONSTRAINT snapshot_idempotency_keys_pkey PRIMARY KEY (run_id, idempotency_key);


--
-- Name: snapshot_messages snapshot_messages_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.snapshot_messages
    ADD CONSTRAINT snapshot_messages_pkey PRIMARY KEY (sha256);


--
-- Name: snapshots snapshots_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.snapshots
    ADD CONSTRAINT snapshots_pkey PRIMARY KEY (seq);


--
-- Name: tool_effects tool_effects_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.tool_effects
    ADD CONSTRAINT tool_effects_pkey PRIMARY KEY (run_id, tool_call_id);


--
-- Name: agent_versions uq_agent_versions_agent_version; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_versions
    ADD CONSTRAINT uq_agent_versions_agent_version UNIQUE (agent_id, version);


--
-- Name: mcp_servers uq_mcp_servers_name; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.mcp_servers
    ADD CONSTRAINT uq_mcp_servers_name UNIQUE (name);


--
-- Name: mcp_servers uq_mcp_servers_url_hash; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.mcp_servers
    ADD CONSTRAINT uq_mcp_servers_url_hash UNIQUE (url_hash);


--
-- Name: model_providers uq_model_providers_name; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.model_providers
    ADD CONSTRAINT uq_model_providers_name UNIQUE (name);


--
-- Name: provider_credentials uq_provider_credentials_provider_name; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.provider_credentials
    ADD CONSTRAINT uq_provider_credentials_provider_name UNIQUE (provider_id, name);


--
-- Name: provider_models uq_provider_models_provider_name_type; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.provider_models
    ADD CONSTRAINT uq_provider_models_provider_name_type UNIQUE (provider_id, name, type);


--
-- Name: skill_versions uq_skill_versions_skill_version; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.skill_versions
    ADD CONSTRAINT uq_skill_versions_skill_version UNIQUE (skill_id, version);


--
-- Name: skills uq_skills_name; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.skills
    ADD CONSTRAINT uq_skills_name UNIQUE (name);


--
-- Name: workspace_files workspace_files_pkey; Type: CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.workspace_files
    ADD CONSTRAINT workspace_files_pkey PRIMARY KEY (namespace, path);


--
-- Name: idx_agent_job_runs_prompt; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_agent_job_runs_prompt ON agent_runtime.agent_job_runs USING btree (prompt_id);


--
-- Name: idx_agent_jobs_created; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_agent_jobs_created ON agent_runtime.agent_jobs USING btree (created_at);


--
-- Name: idx_agent_jobs_lease; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_agent_jobs_lease ON agent_runtime.agent_jobs USING btree (heartbeat_at) WHERE (status = 'running'::text);


--
-- Name: idx_agent_jobs_queue; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_agent_jobs_queue ON agent_runtime.agent_jobs USING btree (conversation_id, created_at);


--
-- Name: idx_conversation_usage_last; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_conversation_usage_last ON agent_runtime.conversation_usage USING btree (last_at);


--
-- Name: idx_events_idempotency; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE UNIQUE INDEX idx_events_idempotency ON agent_runtime.events USING btree (run_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_events_run; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_events_run ON agent_runtime.events USING btree (run_id, seq);


--
-- Name: idx_events_run_started; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_events_run_started ON agent_runtime.events USING btree ("timestamp") WHERE (kind = 'run_started'::text);


--
-- Name: idx_runs_conv; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_runs_conv ON agent_runtime.runs USING btree (conversation_id);


--
-- Name: idx_runs_parent; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_runs_parent ON agent_runtime.runs USING btree (parent_run_id);


--
-- Name: idx_runs_started; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_runs_started ON agent_runtime.runs USING btree (started_at);


--
-- Name: idx_snapshots_conv; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_snapshots_conv ON agent_runtime.snapshots USING btree (conversation_id, seq);


--
-- Name: idx_snapshots_run; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX idx_snapshots_run ON agent_runtime.snapshots USING btree (run_id, seq);


--
-- Name: ix_skill_versions_content_hash; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE INDEX ix_skill_versions_content_hash ON agent_runtime.skill_versions USING btree (content_hash);


--
-- Name: uq_agent_jobs_one_running_per_conversation; Type: INDEX; Schema: agent_runtime; Owner: -
--

CREATE UNIQUE INDEX uq_agent_jobs_one_running_per_conversation ON agent_runtime.agent_jobs USING btree (conversation_id) WHERE (status = ANY (ARRAY['running'::text, 'awaiting'::text]));


--
-- Name: agent_drafts agent_drafts_agent_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_drafts
    ADD CONSTRAINT agent_drafts_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agent_runtime.agents(id);


--
-- Name: agent_revisions agent_revisions_agent_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_revisions
    ADD CONSTRAINT agent_revisions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agent_runtime.agents(id);


--
-- Name: agent_skill_bindings agent_skill_bindings_agent_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_skill_bindings
    ADD CONSTRAINT agent_skill_bindings_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agent_runtime.agents(id);


--
-- Name: agent_skill_bindings agent_skill_bindings_skill_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_skill_bindings
    ADD CONSTRAINT agent_skill_bindings_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES agent_runtime.skills(id);


--
-- Name: agent_version_skills agent_version_skills_skill_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_version_skills
    ADD CONSTRAINT agent_version_skills_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES agent_runtime.skills(id);


--
-- Name: agent_version_skills agent_version_skills_version_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_version_skills
    ADD CONSTRAINT agent_version_skills_version_id_fkey FOREIGN KEY (version_id) REFERENCES agent_runtime.agent_versions(id);


--
-- Name: agent_versions agent_versions_agent_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.agent_versions
    ADD CONSTRAINT agent_versions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agent_runtime.agents(id);


--
-- Name: default_models default_models_provider_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.default_models
    ADD CONSTRAINT default_models_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES agent_runtime.model_providers(id);


--
-- Name: sessions fk_sessions_agent_version; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.sessions
    ADD CONSTRAINT fk_sessions_agent_version FOREIGN KEY (agent_version_id) REFERENCES agent_runtime.agent_versions(id);


--
-- Name: sessions fk_sessions_preview_agent; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.sessions
    ADD CONSTRAINT fk_sessions_preview_agent FOREIGN KEY (preview_agent_id) REFERENCES agent_runtime.agents(id);


--
-- Name: provider_credentials provider_credentials_provider_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.provider_credentials
    ADD CONSTRAINT provider_credentials_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES agent_runtime.model_providers(id) ON DELETE CASCADE;


--
-- Name: provider_models provider_models_provider_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.provider_models
    ADD CONSTRAINT provider_models_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES agent_runtime.model_providers(id) ON DELETE CASCADE;


--
-- Name: skill_draft_files skill_draft_files_skill_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.skill_draft_files
    ADD CONSTRAINT skill_draft_files_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES agent_runtime.skills(id);


--
-- Name: skill_version_files skill_version_files_version_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.skill_version_files
    ADD CONSTRAINT skill_version_files_version_id_fkey FOREIGN KEY (version_id) REFERENCES agent_runtime.skill_versions(id);


--
-- Name: skill_versions skill_versions_skill_id_fkey; Type: FK CONSTRAINT; Schema: agent_runtime; Owner: -
--

ALTER TABLE ONLY agent_runtime.skill_versions
    ADD CONSTRAINT skill_versions_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES agent_runtime.skills(id);



