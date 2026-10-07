"""按包声明读一份文件：认标签、查属性和引用，记下有名字的节点。

工程文件和运行文件用同一套规则，只是文件头里的写法名、根标签、能引入的包和自带的标签不同。"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final

from iclip.capabilities.iclip_studio.film.kits import Kit
from iclip.capabilities.iclip_studio.film.markup import MarkupError, Node, is_reference, parse
from iclip.capabilities.iclip_studio.film.packages import TEMPLATE, Attr, Package, Tag, ValueType

_ID: Final = re.compile(r"[\w一-鿿][\w一-鿿-]*")
_SECONDS: Final = re.compile(r"\d+\.\d")
_INTEGER: Final = re.compile(r"\d+")


@dataclass
class Document:
    """读进来的一份文件：节点树、文件里各标签写法对应的声明、有名字的节点，以及查出的问题。"""

    label: str
    """文件名，写在每条问题前面。"""

    root: Node
    tags: dict[str, Tag]
    """文件里的写法（带前缀）→ 声明。"""

    packages: dict[str, Package]
    """文件里的写法（带前缀）→ 它来自哪个包；自带的标签不在里面。"""

    kits: dict[str, Mapping[str, Kit]] = field(default_factory=dict[str, Mapping[str, Kit]])
    """``source`` 引入的模板包：前缀 → 模板名 → 模板。"""

    nodes: dict[str, Node] = field(default_factory=dict[str, Node])
    errors: list[str] = field(default_factory=list[str])

    def error(self, node: Node, message: str) -> None:
        self.error_at(node.line, message)

    def error_at(self, line: int, message: str) -> None:
        self.errors.append(f"{self.label} 第 {line} 行：{message}")

    def declared(self, node: Node) -> Tag:
        return self.tags[node.tag]

    def is_a(self, node: Node, name: str, package: Package | None = None) -> bool:
        """``node`` 是不是声明名为 ``name`` 的标签；给了 ``package`` 时还要来自这个包。"""

        tag = self.tags.get(node.tag)
        if tag is None or tag.name != name:
            return False
        return package is None or self.packages.get(node.tag) is package

    def kids(self, node: Node, name: str) -> list[Node]:
        return [child for child in node.children if self.is_a(child, name)]

    def find(self, name: str, package: Package | None = None) -> list[Node]:
        """全文件里声明名字是 ``name`` 的标签，按先后。"""

        return [node for node in self.root.walk() if self.is_a(node, name, package)]

    def template(self, reference: str) -> Kit:
        """``{前缀.模板名}`` 指的模板；只用在读文件时已经查过类型的引用上。"""

        prefix, _, name = reference.partition(".")
        return self.kits[prefix][name]

    def type_of(self, reference: str, at: Node) -> ValueType | None:
        """``{引用}`` 的类型；没定义、写在引用它的地方之后、或输出路径不对时记一条问题并返回 None。"""

        name, _, path = reference.partition(".")
        templates = self.kits.get(name)
        if templates is not None:
            if path not in templates:
                listed = "、".join(f"{{{name}.{template}}}" for template in templates)
                self.error(at, f"{{{reference}}} 不是模板包里的模板，可以写 {listed}")
                return None
            return TEMPLATE
        target = self.nodes.get(name)
        if target is None or target.line > at.line:
            self.error(at, f"{{{reference}}} 在这之前没有定义")
            return None
        output = self.declared(target).output
        if output is None:
            self.error(at, f"{{{reference}}} 写法不对，{target.tag} 没有输出")
            return None
        if output[0] != path:
            right = f"{{{name}.{output[0]}}}" if output[0] else f"{{{name}}}"
            self.error(at, f"{{{reference}}} 写法不对，{target.tag} 的输出是 {right}")
            return None
        return output[1]


def load(
    source: str,
    *,
    label: str,
    using: str,
    root_tag: str,
    packages: Mapping[str, Package],
    kits: Mapping[str, Mapping[str, Kit]] | None = None,
    builtins: tuple[Tag, ...] = (),
) -> Document:
    """读一份文件并按声明检查；XML 本身读不通时抛 ``MarkupError``，其余问题记在返回值里。

    ``kits`` 是能用 ``source`` 引入的模板包，不给就是一个也没有。"""

    chosen, root = parse(source, using=using)
    if chosen != using or root.tag != root_tag:
        raise MarkupError(1, f"只认 {using} 的 <{root_tag}>")
    document = Document(label, root, {tag.name: tag for tag in builtins}, {})
    for node in root.children:
        if node.tag == "import":
            _import(document, node, packages, kits or {})
    body_started = False
    for node in root.walk():
        if node is root:
            continue
        if node.tag == "import":
            if body_started:
                document.error(node, "import 要写在最前面")
            continue
        tag = document.tags.get(node.tag)
        body_started = body_started or tag is None or not tag.preamble
        if tag is None:
            document.error(
                node, f"不认识的标签 {node.tag}（没有 import 它的包，或包里没有这个标签）"
            )
            continue
        _check_node(document, node, tag)
    return document


def _import(
    document: Document,
    node: Node,
    packages: Mapping[str, Package],
    kits: Mapping[str, Mapping[str, Kit]],
) -> None:
    attrs = node.attrs
    if ("from" in attrs) == ("source" in attrs):
        document.error(node, "import 里 from 和 source 只写一个")
        return
    prefix = attrs.get("as")
    if prefix is not None and not _ID.fullmatch(prefix):
        document.error(node, f"前缀 {prefix} 里有不能用的字符")
        return
    if "source" in attrs:
        templates = kits.get(attrs["source"])
        if templates is None:
            document.error(node, f"没有这个模板包：{attrs['source']}")
        elif prefix is None:
            document.error(node, "用 source 引入的模板包要写 as")
        elif prefix in document.kits:
            document.error(node, f"前缀 {prefix} 和前面引入的模板包重名")
        else:
            document.kits[prefix] = templates
        return
    package = packages.get(attrs["from"])
    if package is None:
        document.error(node, f"没有这个包：{attrs['from']}")
        return
    if package.bare and prefix is not None:
        document.error(node, f"{package.ref} 不写 as")
        return
    if not package.bare and prefix is None:
        document.error(node, f"{package.ref} 要写 as，给它的标签起前缀")
        return
    for tag in package.tags:
        written = tag.name if prefix is None else f"{prefix}:{tag.name}"
        if written in document.tags:
            document.error(node, f"标签 {written} 和前面引入的包重名")
        document.tags[written] = tag
        document.packages[written] = package


def _check_node(document: Document, node: Node, tag: Tag) -> None:
    if not _placed(document, node, tag):
        document.error(node, f"{node.tag} 不能写在这里")
    known = {attr.name: attr for attr in tag.attrs}
    for name, value in node.attrs.items():
        attr = known.get(name)
        if attr is None:
            document.error(node, f"{node.tag} 没有属性 {name}")
        else:
            _check_value(document, node, attr, value)
    for attr in tag.attrs:
        if attr.required and attr.name not in node.attrs:
            document.error(node, f"{node.tag} 缺属性 {attr.name}")
    for child, (low, high) in tag.children.items():
        count = len(document.kids(node, child))
        if count < low or (high is not None and count > high):
            limit = "任意" if high is None else str(high)
            document.error(node, f"{node.tag} 下的 {child} 要 {low}–{limit} 个，写了 {count} 个")
    if not tag.body and node.has_text:
        document.error(node, f"{node.tag} 不收正文")
    name = node.attrs.get("id")
    if name is not None:
        if name in document.nodes or name in document.kits:
            document.error(node, f"名字 {name} 重复")
        document.nodes[name] = node


def _placed(document: Document, node: Node, tag: Tag) -> bool:
    parent = node.parent
    if parent is None or parent is document.root:
        return tag.top
    holder = document.tags.get(parent.tag)
    return (
        holder is not None
        and tag.name in holder.children
        and document.packages.get(parent.tag) is document.packages.get(node.tag)
    )


def _check_value(document: Document, node: Node, attr: Attr, value: str) -> None:
    name = attr.name
    if attr.kind == "ref":
        reference = node.reference(name)
        if reference is None:
            document.error(node, f"{name} 要写引用，如 {name}={{名字}}，不加引号")
            return
        got = document.type_of(reference, node)
        if got is not None and got != attr.type:
            document.error(node, f"{name} 要「{attr.type}」，{{{reference}}} 是「{got}」")
    elif is_reference(value):
        document.error(node, f"{name} 是普通值，要加引号，不能写引用")
    elif attr.kind == "enum" and value not in attr.values:
        document.error(node, f"{name} 只能是 {' | '.join(attr.values)}，写的是 {value}")
    elif attr.kind == "int" and not _INTEGER.fullmatch(value):
        document.error(node, f"{name} 要写整数，写的是 {value}")
    elif attr.kind == "seconds" and not _SECONDS.fullmatch(value):
        document.error(node, f"{name} 要写秒数，带一位小数，写的是 {value}")
    elif attr.kind == "id" and not _ID.fullmatch(value):
        document.error(node, f"名字 {value} 里有不能用的字符")


__all__ = ["Document", "load"]
