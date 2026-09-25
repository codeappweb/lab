---
layout: default
title: "Xe & Di Chuyển"
description: "Kiến thức thực dụng về xe máy, xe điện, xe đạp, sửa chữa, pháp lý giao thông và du lịch bằng xe — bắt đầu từ Hà Nội."
---
<section class="hero">
  <div class="hero__inner container">
    <h1>Kiến thức xe &amp; di chuyển, viết cho người thật sự đi đường</h1>
    <p class="hero__sub">Hệ sinh thái nội dung về xe máy, xe điện, xe đạp, sửa chữa, pháp lý giao thông và du lịch bằng xe quanh Hà Nội — mỗi bài trả lời đúng một câu hỏi thực tế.</p>
    <form class="hero__search" id="heroSearch" role="search">
      <input type="search" placeholder="Tìm kiếm: đề yếu, đi mưa, pin LFP…" aria-label="Tìm kiếm">
      <button class="go" type="submit" aria-label="Tìm">{% include icon.html name="search" %}</button>
    </form>
    <a class="hero__cta" href="#danh-muc">Khám phá 12 danh mục {% include icon.html name="arrow" %}</a>
    <button type="button" class="hero__ai" data-assistant-open>{% include icon.html name="chat" %} Hỏi Trợ lý AI</button>
    <div class="hero__stats">
      <div class="hero__stat"><b>12</b><span>danh mục</span></div>
      <div class="hero__stat"><b>{{ site.posts | size }}</b><span>bài đã xuất bản</span></div>
      <div class="hero__stat"><b>201</b><span>chủ đề đã lên kế hoạch</span></div>
    </div>
  </div>
</section>

<section class="section container" id="danh-muc">
  <h2 class="section-title">Danh mục</h2>
  <div class="topic-grid">
    {% for p in site.data.taxonomy.parents %}
    {% capture purl %}/danh-muc/{{ p.slug }}/{% endcapture %}
    {% assign pcount = 0 %}
    {% for post in site.posts %}
      {% assign pc = post.parent_category | default: '' %}
      {% if pc == '' %}{% assign t = site.data['article-taxonomy'][post.slug] %}{% if t %}{% assign pc = t.parent %}{% endif %}{% endif %}
      {% if pc == p.slug %}{% assign pcount = pcount | plus: 1 %}{% endif %}
    {% endfor %}
    <a class="topic-card" href="{{ purl | relative_url }}">
      <span class="topic-card__icon">{% include icon.html name=p.icon %}</span>
      <span class="topic-card__title">{{ p.name }}</span>
      <span class="topic-card__desc">{{ p.description | truncate: 110 }}</span>
      <span class="topic-card__meta">{% if pcount > 0 %}{{ pcount }} bài{% else %}Sắp ra mắt{% endif %}</span>
    </a>
    {% endfor %}
  </div>
  <p><a href="{{ '/danh-muc/' | relative_url }}">Xem tất cả danh mục và chuyên mục</a></p>
</section>

<section class="section section--tight container" id="doc-tiep" hidden>
  <h2 class="section-title">Đọc tiếp</h2>
  <div class="card-grid" id="continueList"></div>
</section>

{% if site.posts.size > 0 %}
<section class="section container" id="moi-nhat">
  <h2 class="section-title">Mới nhất</h2>
  {% assign latest = site.posts | sort: 'date' | reverse %}
  <div class="card-grid">
  {% for p in latest limit: 7 %}
    {% if forloop.first %}
      {% include article-card.html post=p size='featured' %}
    {% else %}
      {% include article-card.html post=p %}
    {% endif %}
  {% endfor %}
  </div>
</section>
{% endif %}

<section class="section section--tight container" id="kham-pha">
  <h2 class="section-title">Khám phá</h2>
  <div class="chips">
    {% for e in site.data.entities limit: 16 %}
    <button type="button" class="chip" data-search-open data-search="{{ e.name | escape }}">{{ e.name }}</button>
    {% endfor %}
  </div>
</section>
