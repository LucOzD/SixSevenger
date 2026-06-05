# recommender.py
# Posts as points in N-dimensional TF-IDF vector space.
# Categories discovered via clustering on that space.
# Category topology: knows which categories are similar and HOW they differ.
# User profiling: builds interest vector from interactions, then finds
# not just liked categories but similar ones weighted by relevance.

import re
import pickle
import os
import numpy as np
from collections import defaultdict
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.cluster import MiniBatchKMeans
from sklearn.preprocessing import normalize


class CategoryTopology:
    """
    Builds and maintains a map of how all discovered categories
    relate to each other in vector space.

    For each pair of categories it stores:
      - similarity:   cosine similarity of their centroids (0-1)
      - diff_dims:    the top TF-IDF dimensions (words) that most
                      distinguish the two categories from each other
      - diff_vector:  the normalised difference vector, used for
                      directional recommendations

    This lets the recommender answer:
      "The user likes category A. Which other categories are similar,
       and in what way do they differ — so we only surface the ones
       that differ in directions the user has not rejected?"
    """

    def __init__(self):
        self.centroids    = {}   # cat_id -> mean vector of all posts in that category
        self.similarities = {}   # (cat_a, cat_b) -> float
        self.diff_dims    = {}   # (cat_a, cat_b) -> [top distinguishing words]
        self.diff_vectors = {}   # (cat_a, cat_b) -> normalised diff vector

        self.n_posts = defaultdict(int)

    def update(self, cat_id, post_vector):
        """
        Update the centroid for a category with a new post vector.
        Uses an online mean so we never store all post vectors.
        """
        n = self.n_posts[cat_id]
        if cat_id not in self.centroids:
            self.centroids[cat_id] = post_vector.copy()
        else:
            self.centroids[cat_id] = (
                self.centroids[cat_id] * n + post_vector
            ) / (n + 1)
        self.n_posts[cat_id] += 1

    def rebuild_relations(self, feature_names):
        """
        Recompute all pairwise relationships between category centroids.
        Called every N posts rather than on every update.
        """
        cats = list(self.centroids.keys())
        if len(cats) < 2:
            return

        for i, cat_a in enumerate(cats):
            for cat_b in cats[i + 1:]:
                vec_a = self.centroids[cat_a]
                vec_b = self.centroids[cat_b]

                # Cosine similarity between centroids
                dot  = float(np.dot(vec_a, vec_b))
                norm = float(np.linalg.norm(vec_a) * np.linalg.norm(vec_b))
                sim  = dot / norm if norm > 0 else 0.0

                self.similarities[(cat_a, cat_b)] = sim
                self.similarities[(cat_b, cat_a)] = sim

                # Difference vector: direction FROM cat_b TO cat_a
                diff = vec_a - vec_b
                diff_norm = np.linalg.norm(diff)
                diff_n = diff / diff_norm if diff_norm > 0 else diff

                self.diff_vectors[(cat_a, cat_b)] =  diff_n
                self.diff_vectors[(cat_b, cat_a)] = -diff_n

                # Words that most distinguish cat_a from cat_b
                if feature_names is not None and len(feature_names) > 0:
                    top_a_idx = diff_n.argsort()[-6:][::-1]
                    top_b_idx = (-diff_n).argsort()[-6:][::-1]
                    self.diff_dims[(cat_a, cat_b)] = [
                        str(feature_names[i]) for i in top_a_idx if i < len(feature_names)
                    ]
                    self.diff_dims[(cat_b, cat_a)] = [
                        str(feature_names[i]) for i in top_b_idx if i < len(feature_names)
                    ]

    def get_similar_categories(self, cat_id, n=5, min_similarity=0.05):
        scores = {}
        for (a, b), sim in self.similarities.items():
            if a == cat_id and sim >= min_similarity:
                scores[b] = sim
        return sorted(scores.items(), key=lambda x: x[1], reverse=True)[:n]

    def describe_relationship(self, cat_a, cat_b):
        sim   = self.similarities.get((cat_a, cat_b), 0)
        words = self.diff_dims.get((cat_a, cat_b), [])
        return {'similarity': round(sim, 3), 'cat_a_distinctive_words': words}


class PostAnalyser:
    """
    Embeds posts into TF-IDF vector space and clusters them into
    dynamically discovered categories.

    Each post = a point in vocabulary-dimensional space.
    Each category = a cluster centroid (average position of its posts).
    """

    def __init__(self, n_categories=30, min_posts_before_cluster=100):
        self.vectorizer = TfidfVectorizer(
            max_features=5000,
            stop_words='english',
            min_df=2,
            ngram_range=(1, 2),
            strip_accents='unicode',
            sublinear_tf=True,
        )
        self.clusterer = MiniBatchKMeans(
            n_clusters=n_categories,
            batch_size=100,
            n_init=3,
            random_state=42,
        )
        self.n_categories   = n_categories
        self.is_fitted      = False
        self.pending_posts  = []
        self.min_posts      = min_posts_before_cluster
        self.category_words = {}
        self.topology       = CategoryTopology()
        self._post_count    = 0
        self._feature_names = None

    def _clean(self, text):
        text = text.lower()
        text = re.sub(r'http\S+', '', text)
        text = re.sub(r'@\w+', '', text)
        text = re.sub(r'[^a-z0-9#\s]', ' ', text)
        return text.strip()

    def add_post(self, post_id, text):
        """
        Embed post, assign category, update topology.
        Returns (category_id, dense_vector_list).
        Returns (-1, None) while still buffering.
        """
        cleaned = self._clean(text)
        self.pending_posts.append((post_id, cleaned))

        if not self.is_fitted and len(self.pending_posts) < self.min_posts:
            return -1, None

        if not self.is_fitted:
            texts  = [p[1] for p in self.pending_posts]
            vecs   = self.vectorizer.fit_transform(texts)
            self._feature_names = self.vectorizer.get_feature_names_out()
            vecs_n = normalize(vecs)
            self.clusterer.partial_fit(vecs_n)
            self.is_fitted = True
            self._update_category_words()

            cats = self.clusterer.predict(vecs_n)
            for i, cat_id in enumerate(cats):
                dense = np.asarray(vecs_n[i].todense()).flatten()
                self.topology.update(int(cat_id), dense)
            self.topology.rebuild_relations(self._feature_names)

            last_cat = int(cats[-1])
            last_vec = np.asarray(vecs_n[-1].todense()).flatten()
            return last_cat, last_vec.tolist()

        vec   = self.vectorizer.transform([cleaned])
        vec_n = normalize(vec)
        self.clusterer.partial_fit(vec_n)
        self._update_category_words()

        cat_id = int(self.clusterer.predict(vec_n)[0])
        dense  = np.asarray(vec_n.todense()).flatten()

        self.topology.update(cat_id, dense)

        self._post_count += 1
        if self._post_count % 50 == 0:
            self.topology.rebuild_relations(self._feature_names)

        return cat_id, dense.tolist()

    def _update_category_words(self):
        names   = self.vectorizer.get_feature_names_out()
        centers = self.clusterer.cluster_centers_
        for cat_id, center in enumerate(centers):
            top_idx = center.argsort()[-10:][::-1]
            self.category_words[cat_id] = [names[i] for i in top_idx]

    def describe(self, cat_id):
        words = self.category_words.get(int(cat_id), [])
        return ', '.join(words) if words else f'category_{cat_id}'

    def save(self, path='recommender_state.pkl'):
        with open(path, 'wb') as f:
            pickle.dump(self, f)

    @staticmethod
    def load(path='recommender_state.pkl'):
        with open(path, 'rb') as f:
            return pickle.load(f)


class UserProfiler:
    """
    Tracks each user as a weighted interest vector over categories.

    Scoring logic for ranked_categories:
    1. Direct score  — from explicit interactions (likes/comments/dislikes)
    2. Topology bonus — categories similar to liked ones get a boost
       scaled by how similar they are to the source category
    3. Topology penalty — categories similar to disliked ones lose score
    4. Directional alignment — user's aggregate interest vector is compared
       to each category centroid; categories that point in the same direction
       as the user's overall taste score higher
    5. Novelty floor — every category keeps a minimum score so discovery works
    """

    SIGNAL_WEIGHTS = {
        'like':    0.10,
        'dislike': -0.06,
        'comment': 0.07,
        'save':    0.15,
        'view':    0.02,
    }

    def __init__(self):
        self.profiles      = defaultdict(lambda: defaultdict(float))
        self.interest_vecs = {}   # user_id -> weighted sum of liked centroids
        self.dislike_vecs  = {}   # user_id -> weighted sum of disliked centroids

    def update(self, user_id, category_id, signal, category_centroid=None):
        delta = self.SIGNAL_WEIGHTS.get(signal, 0)
        self.profiles[user_id][category_id] += delta
        self.profiles[user_id][category_id] = max(
            0.0, self.profiles[user_id][category_id]
        )

        if category_centroid is not None:
            centroid = np.array(category_centroid)
            weight   = abs(delta)
            if delta > 0:
                prev = np.array(self.interest_vecs.get(user_id, centroid))
                self.interest_vecs[user_id] = (prev + centroid * weight).tolist()
            elif delta < 0:
                prev = np.array(self.dislike_vecs.get(user_id, centroid))
                self.dislike_vecs[user_id] = (prev + centroid * weight).tolist()

    def get_ranked_categories(self, user_id, topology, n=20):
        """
        Returns [(category_id, score), ...] sorted by relevance.
        Accounts for direct interest, cross-category similarity,
        dislike penalties, and directional alignment.
        """
        direct   = dict(self.profiles.get(user_id, {}))
        all_cats = set(topology.centroids.keys()) | set(direct.keys())
        scores   = {cat: direct.get(cat, 0.01) for cat in all_cats}

        # Boost categories similar to liked ones
        for liked_cat, liked_score in direct.items():
            if liked_score <= 0:
                continue
            for sim_cat, sim_score in topology.get_similar_categories(liked_cat, n=5):
                boost = liked_score * sim_score * 0.5
                scores[sim_cat] = scores.get(sim_cat, 0.01) + boost

        # Penalise categories similar to disliked ones
        for disliked_cat, disliked_score in direct.items():
            if disliked_score >= 0:
                continue
            for sim_cat, sim_score in topology.get_similar_categories(disliked_cat, n=5):
                penalty = abs(disliked_score) * sim_score * 0.3
                scores[sim_cat] = max(0.0, scores.get(sim_cat, 0.01) - penalty)

        # Directional alignment: re-weight by how close each category centroid
        # is to the user's aggregate interest direction
        if user_id in self.interest_vecs:
            interest   = np.array(self.interest_vecs[user_id])
            int_norm   = np.linalg.norm(interest)
            if int_norm > 0:
                interest_n = interest / int_norm
                for cat_id, centroid in topology.centroids.items():
                    c      = np.array(centroid)
                    c_norm = np.linalg.norm(c)
                    if c_norm > 0:
                        # Cosine alignment: -1 (opposite) to 1 (same direction)
                        alignment = float(np.dot(interest_n, c / c_norm))
                        # Rescale to 0.1–1.0 so misaligned cats still show occasionally
                        factor = max(0.1, (alignment + 1) / 2)
                        scores[cat_id] = scores.get(cat_id, 0.01) * factor

        return sorted(scores.items(), key=lambda x: x[1], reverse=True)[:n]

    def decay_all(self, factor=0.97):
        for uid in self.profiles:
            for cat in self.profiles[uid]:
                self.profiles[uid][cat] *= factor

    def top_interests(self, user_id, n=5):
        profile = self.profiles.get(user_id, {})
        return sorted(profile.items(), key=lambda x: x[1], reverse=True)[:n]
