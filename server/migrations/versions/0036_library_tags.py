"""iclip：资料库标签。新表 ``library_tags``、``library_entries``、``library_entry_tags``，参考视频的两组
标签搬过去后删掉 ``video_types``、``categories``。

Revision ID: 7f3c2a9d1e64
Revises: b5d1e7a0c934
Create Date: 2026-10-21 12:00:00.000000

``library_tags`` 是一棵树：``parent_id`` 为空的是维度，维度行上的 ``auto_fill`` 说这一维度由谁打。
``library_entries`` 是某一库里的一条（``kind``：``reference`` 指参考视频，``hit_case`` 指素材片），带
打标状态；``library_entry_tags`` 是它打上的标签。预置五个维度；每条现有的参考视频建一条
``reference`` 条目，旧的片子类型按大类、品类按名字搬过去，有拆解的记为已打标。

降级删掉三张表，加回两列与索引，标签丢弃：旧版本没有可配置的标签。
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any, Final

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "7f3c2a9d1e64"
down_revision: str | None = "b5d1e7a0c934"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"

CATEGORIES: Final = (
    "高跟鞋",
    "平底鞋",
    "乐福鞋",
    "牛津鞋",
    "一脚蹬",
    "穆勒鞋",
    "拖鞋",
    "短靴",
    "中筒靴",
    "及膝靴",
    "过膝靴",
    "高跟凉鞋",
    "坡跟凉鞋",
    "厚底凉鞋",
    "平底凉鞋",
    "夹趾拖",
    "凉拖鞋",
    "运动凉鞋",
    "跑鞋",
    "足球鞋",
    "篮球鞋",
    "啦啦队鞋",
    "棒&垒球鞋",
    "滑板鞋",
    "舞蹈鞋",
    "橄榄球鞋",
    "高尔夫鞋",
    "网球鞋",
    "训练鞋",
    "女性骑行鞋",
    "健步鞋",
    "板鞋",
    "徒步鞋",
    "徒步靴",
    "雪地靴",
    "雨靴",
    "水鞋",
    "猎靴",
    "医疗用鞋",
    "餐厨用鞋",
    "军事用靴",
    "工业用鞋",
    "工业用靴",
    "皮带",
    "钱包",
    "包",
    "袜子",
    "鞋垫",
    "T恤",
    "衬衫",
    "卫衣",
    "毛衣",
    "外套",
    "裤子",
    "半身裙",
    "连衣裙",
)
"""迁移时参考视频的品类清单，顺序照旧。"""

STRUCTURE: Final[tuple[tuple[str, str, tuple[tuple[str, str], ...]], ...]] = (
    (
        "产品展示型",
        "产品本身是主体，拍特写、细节、功能，或拍它怎么做出来",
        (
            ("360°全景展示", "360 Spin"),
            ("细节微距特写", "Macro Detail"),
            ("功能暴力测试", "Stress Test"),
            ("拆解/组装演示", "Exploded View"),
        ),
    ),
    (
        "真人种草型",
        "模特穿上或戴上产品展示上身效果，或人物在生活场景里自然地使用产品，不对着镜头讲解",
        (
            ("动态上身展示", "Static Try-on"),
            ("动态场景跟拍", "Action Follow"),
            ("POV 第一人称视角", "POV Experience"),
            ("多场景快速切换", "Multi-Scene Montage"),
        ),
    ),
    (
        "口播讲解型",
        "有人对着镜头讲，说话占了大部分时长",
        (
            ("专家评测解说", "Expert Review"),
            ("痛点解决方案", "Problem Solver"),
            ("沉浸式 ASMR", "Silent ASMR"),
            ("幕后/工厂探秘", "Behind the Scenes"),
        ),
    ),
    (
        "开箱测评型",
        "拆包装上手，或在片中做测试、对比",
        (
            ("标准开箱流程", "Standard Unboxing"),
            ("极速上手体验", "Quick First Look"),
            ("对比测评", "Comparison Battle"),
        ),
    ),
    (
        "剧情叙事型",
        "有角色和情节，人物之间的互动推着故事往前走",
        (
            ("困境反转剧", "Problem-Solution Arc"),
            ("幽默反转型", "Comedy Twist"),
            ("情感共鸣剧", "Emotional Journey"),
            ("挑战任务剧", "Challenge Based"),
        ),
    ),
    (
        "素材混剪型",
        "不是连贯的实拍：由图片、零散素材拼成，或是动画、三维渲染",
        (
            ("卡点变装/转场", "Beat Sync Transition"),
            ("用户评价拼贴", "Review Mashup"),
            ("图文幻灯片", "Photo Slideshow"),
        ),
    ),
    (
        "直播切片优化型",
        "画面来自直播间，主播在直播布景前讲",
        (
            ("高光时刻剪辑", "Highlight Reel"),
            ("问答集锦", "Q&A Compilation"),
        ),
    ),
)
"""内容结构的大类（名字、判断句）与各自的小类（名字、英文名）。"""

OLD_TYPES: Final = {
    "product_showcase": "产品展示型",
    "try_on": "真人种草型",
    "lifestyle": "真人种草型",
    "talking_head": "口播讲解型",
    "review": "开箱测评型",
    "drama": "剧情叙事型",
    "slideshow": "素材混剪型",
    "live_clip": "直播切片优化型",
}
"""旧片子类型落到哪个大类。"""

_tags = sa.table(
    "library_tags",
    sa.column("id", sa.Uuid()),
    sa.column("parent_id", sa.Uuid()),
    sa.column("name", sa.Text()),
    sa.column("auto_fill", sa.Text()),
    sa.column("guide", sa.Text()),
    sa.column("position", sa.Integer()),
    schema=SCHEMA,
)


def _row(
    parent: uuid.UUID | None,
    name: str,
    position: int,
    *,
    guide: str | None = None,
    auto_fill: str | None = None,
) -> dict[str, Any]:
    return {
        "id": uuid.uuid4(),
        "parent_id": parent,
        "name": name,
        "auto_fill": auto_fill,
        "guide": guide,
        "position": position,
    }


def _seed() -> tuple[list[dict[str, Any]], dict[str, uuid.UUID], dict[str, uuid.UUID]]:
    """预置的全部行，以及大类名与品类名各自的 id。"""

    rows: list[dict[str, Any]] = []
    brand = _row(None, "品牌", 0)
    channel = _row(None, "平台&渠道", 1)
    category = _row(
        None,
        "品类",
        2,
        auto_fill="ai",
        guide="看出场的产品，每个产品选一个最贴切的；模特顺带穿的衣服不算；清单里没有的不选",
    )
    scene = _row(None, "场景", 3, auto_fill="ai")
    structure = _row(
        None,
        "内容结构",
        4,
        auto_fill="ai",
        guide="选最贴切的小类，小类都不贴切时选大类",
    )
    rows += [brand, channel, category, scene, structure]
    rows += [
        _row(channel["id"], name, index)
        for index, name in enumerate(("AMZ", "DTC", "TikTok", "INS", "ADS"))
    ]
    categories = [_row(category["id"], name, index) for index, name in enumerate(CATEGORIES)]
    rows += categories
    rows += [
        _row(scene["id"], name, index)
        for index, name in enumerate(("居家/日常放松", "户外/公园散步", "通勤/长时间站立"))
    ]
    kinds: dict[str, uuid.UUID] = {}
    for index, (name, guide, children) in enumerate(STRUCTURE):
        kind = _row(structure["id"], name, index, guide=guide)
        kinds[name] = kind["id"]
        rows.append(kind)
        rows += [
            _row(kind["id"], child, position, guide=english)
            for position, (child, english) in enumerate(children)
        ]
    return rows, kinds, {row["name"]: row["id"] for row in categories}


def upgrade() -> None:
    op.create_table(
        "library_tags",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("auto_fill", sa.Text(), nullable=True),
        sa.Column("guide", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["parent_id"], [f"{SCHEMA}.library_tags.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("parent_id", "name", name="uq_library_tags_parent_name"),
        schema=SCHEMA,
    )
    op.create_index(
        "uq_library_tags_dimension_name",
        "library_tags",
        ["name"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("parent_id IS NULL"),
    )
    op.create_table(
        "library_entries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("reference_id", sa.Uuid(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("tag_status", sa.Text(), nullable=True),
        sa.Column("tag_error", sa.Text(), nullable=True),
        sa.Column("tag_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["reference_id"], [f"{SCHEMA}.reference_videos.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["job_id"], [f"{SCHEMA}.generation_jobs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], [f"{SCHEMA}.users.id"]),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_index(
        "uq_library_entries_reference",
        "library_entries",
        ["kind", "reference_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("reference_id IS NOT NULL"),
    )
    op.create_index(
        "uq_library_entries_job",
        "library_entries",
        ["kind", "job_id"],
        unique=True,
        schema=SCHEMA,
        postgresql_where=sa.text("job_id IS NOT NULL"),
    )
    op.create_table(
        "library_entry_tags",
        sa.Column("entry_id", sa.Uuid(), nullable=False),
        sa.Column("tag_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["entry_id"], [f"{SCHEMA}.library_entries.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tag_id"], [f"{SCHEMA}.library_tags.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("entry_id", "tag_id"),
        schema=SCHEMA,
    )
    op.create_index("ix_library_entry_tags_tag", "library_entry_tags", ["tag_id"], schema=SCHEMA)

    rows, kinds, categories = _seed()
    op.bulk_insert(_tags, rows)

    connection = op.get_bind()
    connection.execute(
        sa.text(
            f"INSERT INTO {SCHEMA}.library_entries"
            " (id, kind, reference_id, tag_status, created_by, created_at)"
            " SELECT gen_random_uuid(), 'reference', r.id,"
            "  CASE WHEN r.document IS NOT NULL THEN 'completed' END,"
            "  r.owner_user_id, r.created_at"
            f" FROM {SCHEMA}.reference_videos r"
        )
    )
    moves = (
        ("video_types", {code: kinds[name] for code, name in OLD_TYPES.items()}),
        ("categories", categories),
    )
    for column, mapping in moves:
        connection.execute(
            sa.text(
                f"INSERT INTO {SCHEMA}.library_entry_tags (entry_id, tag_id)"
                " SELECT DISTINCT e.id, m.tag_id"
                f" FROM {SCHEMA}.library_entries e"
                f" JOIN {SCHEMA}.reference_videos r ON r.id = e.reference_id"
                f" CROSS JOIN LATERAL unnest(r.{column}) AS v(value)"
                " JOIN unnest(CAST(:values AS text[]), CAST(:tag_ids AS uuid[]))"
                "  AS m(value, tag_id) ON m.value = v.value"
            ),
            {"values": list(mapping), "tag_ids": list(mapping.values())},
        )

    op.drop_index("ix_reference_videos_video_types", "reference_videos", schema=SCHEMA)
    op.drop_index("ix_reference_videos_categories", "reference_videos", schema=SCHEMA)
    op.drop_column("reference_videos", "video_types", schema=SCHEMA)
    op.drop_column("reference_videos", "categories", schema=SCHEMA)


def downgrade() -> None:
    """删三张表，加回两列（空）与它们的索引；标签丢弃。"""

    for column in ("video_types", "categories"):
        op.add_column(
            "reference_videos",
            sa.Column(
                column,
                postgresql.ARRAY(sa.Text()),
                nullable=False,
                server_default=sa.text("'{}'"),
            ),
            schema=SCHEMA,
        )
        op.create_index(
            f"ix_reference_videos_{column}",
            "reference_videos",
            [column],
            schema=SCHEMA,
            postgresql_using="gin",
        )
    op.drop_table("library_entry_tags", schema=SCHEMA)
    op.drop_table("library_entries", schema=SCHEMA)
    op.drop_table("library_tags", schema=SCHEMA)
