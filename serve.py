# serve.py
# Run alongside Node.js:  npm start  (uses concurrently)
# Or standalone:          python serve.py

import os
import json
import atexit
import numpy as np
from flask import Flask, request, jsonify
from recommender import PostAnalyser, UserProfiler

app     = Flask(__name__)
STATE   = 'recommender_state.pkl'

analyser = PostAnalyser.load(STATE) if os.path.exists(STATE) else PostAnalyser()
profiler = UserProfiler()

atexit.register(lambda: analyser.save(STATE))


# ------------------------------------------------------------------
# POST /categorise
# Called when a post is created.
# Returns category_id, the post's vector, and the category's words.
# ------------------------------------------------------------------
@app.route('/categorise', methods=['POST'])
def categorise():
    data    = request.json
    text    = data.get('text', '')
    post_id = data.get('post_id')

    cat_id, post_vec = analyser.add_post(post_id, text)

    if len(analyser.pending_posts) % 50 == 0:
        analyser.save(STATE)

    return jsonify({
        'category_id':    cat_id,
        'post_vector':    post_vec,           # stored in SQLite for post-to-post similarity
        'category_words': analyser.category_words.get(cat_id, []),
        'status':         'buffering' if cat_id == -1 else 'ok',
    })


# ------------------------------------------------------------------
# POST /interact
# Called on every like, dislike, comment, save.
# Passes the category centroid so the user's directional vector updates.
# ------------------------------------------------------------------
@app.route('/interact', methods=['POST'])
def interact():
    data        = request.json
    user_id     = str(data['user_id'])
    category_id = int(data['category_id'])
    signal      = data['signal']

    # Pass the category centroid so the user's directional interest
    # vector gets updated (not just the per-category score)
    centroid = analyser.topology.centroids.get(category_id)

    profiler.update(user_id, category_id, signal, category_centroid=centroid)
    return jsonify({'ok': True})


# ------------------------------------------------------------------
# POST /ranked-categories
# Called by the feed to get personalised category scores.
# Returns [(category_id, score), ...] sorted by relevance.
# ------------------------------------------------------------------
@app.route('/ranked-categories', methods=['POST'])
def ranked_categories():
    user_id = str(request.json['user_id'])
    ranked  = profiler.get_ranked_categories(user_id, analyser.topology, n=30)
    return jsonify({'ranked': [[int(c), float(s)] for c, s in ranked]})


# ------------------------------------------------------------------
# GET /categories
# Inspect discovered topics and their relationships.
# Visit http://localhost:5001/categories in your browser.
# ------------------------------------------------------------------
@app.route('/categories', methods=['GET'])
def categories():
    out = {}
    for cat_id, words in analyser.category_words.items():
        similar = analyser.topology.get_similar_categories(cat_id, n=3)
        out[str(cat_id)] = {
            'words':        words,
            'description':  analyser.describe(cat_id),
            'post_count':   analyser.topology.n_posts.get(cat_id, 0),
            'similar_to':   [
                {
                    'category':    int(sim_id),
                    'similarity':  round(sim_score, 3),
                    'differs_by':  analyser.topology.diff_dims.get((cat_id, sim_id), []),
                }
                for sim_id, sim_score in similar
            ],
        }
    return jsonify(out)


# ------------------------------------------------------------------
# POST /decay  — call from a daily cron job
# ------------------------------------------------------------------
@app.route('/decay', methods=['POST'])
def decay():
    profiler.decay_all()
    return jsonify({'ok': True})


# ------------------------------------------------------------------
# POST /similar-posts
# Given a post vector, find the most similar other posts.
# Used for "more like this" on a post detail page.
# ------------------------------------------------------------------
@app.route('/similar-posts', methods=['POST'])
def similar_posts():
    data       = request.json
    post_vec   = data['post_vector']
    candidates = data['candidates']   # {post_id: vector}
    top_n      = data.get('top_n', 10)

    results = analyser.get_similar_posts(post_vec, candidates, top_n=top_n)
    return jsonify({'similar': [[pid, round(score, 4)] for pid, score in results]})


if __name__ == '__main__':
    print(f'Recommender running on http://localhost:5001')
    print(f'State: {"loaded" if os.path.exists(STATE) else "fresh start"}')
    print(f'Posts buffered: {len(analyser.pending_posts)} / {analyser.min_posts} needed to fit')
    print(f'Model fitted:   {analyser.is_fitted}')
    print(f'Categories:     {len(analyser.category_words)}')
    app.run(port=5001)
