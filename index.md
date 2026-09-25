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
    <a class="hero__cta" href="#chu-de">Khám phá 12 chủ đề {% include icon.html name="arrow" %}</a>
    <div class="hero__stats">
      <div class="hero__stat"><b>12</b><span>chủ đề</span></div>
      <div class="hero__stat"><b>{{ site.posts | size }}</b><span>bài đã xuất bản</span></div>
      <div class="hero__stat"><b>201</b><span>chủ đề đã lên kế hoạch</span></div>
    </div>
  </div>
</section>

<section class="section container" id="chu-de">
  <h2 class="section-title">Chủ đề</h2>
  <div class="topic-grid">
    {% assign hubs = site.pages | where: 'layout', 'hub' | sort: 'cluster' %}
    {% for h in hubs %}
    {% assign count = site.posts | where: 'cluster', h.cluster | size %}
    <a class="topic-card" href="{{ h.url | relative_url }}">
      <span class="topic-card__icon">{% include icon.html name=h.icon %}</span>
      <span class="topic-card__title">{{ h.title }}</span>
      <span class="topic-card__desc">{{ h.description | truncate: 110 }}</span>
      <span class="topic-card__meta">{% if count > 0 %}{{ count }} bài{% else %}Sắp ra mắt{% endif %}</span>
    </a>
    {% endfor %}
  </div>
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
