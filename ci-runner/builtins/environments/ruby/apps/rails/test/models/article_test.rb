require "test_helper"

class ArticleTest < ActiveSupport::TestCase
  test "needs a title" do
    article = Article.new(body: "No title")
    assert_not article.valid?
    assert_includes article.errors[:title], "can't be blank"
  end

  test "saves with a title" do
    article = Article.create!(title: "Third", body: "Saved.")
    assert_equal "Third", Article.find(article.id).title
  end
end
