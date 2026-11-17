require "test_helper"

class ArticlesControllerTest < ActionDispatch::IntegrationTest
  test "lists the articles in order" do
    get articles_url
    assert_response :success
    assert_select "li", 2
    assert_select "li:first-child a", "Hello, Ada"
  end

  test "shows one" do
    get article_url(articles(:hello))
    assert_response :success
    assert_select "h1", "Hello, Ada"
  end
end
