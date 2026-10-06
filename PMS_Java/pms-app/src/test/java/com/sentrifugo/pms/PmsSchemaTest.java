package com.sentrifugo.pms;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Checks the tables Hibernate builds from the entities against the PMS database design: every table exists in
 * schema {@code pms}, with the designed columns, NOT NULL rules, unique keys and foreign keys. Runs on in-memory H2.
 */
@SpringBootTest(
        classes = PmsApplication.class,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:pmsschema;DB_CLOSE_DELAY=-1;INIT=CREATE SCHEMA IF NOT EXISTS pms",
                "spring.datasource.driver-class-name=org.h2.Driver",
                "spring.datasource.username=sa",
                "spring.datasource.password=",
                "spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.H2Dialect",
                "spring.jpa.hibernate.ddl-auto=create-drop"
        })
class PmsSchemaTest {

    @MockitoBean
    StringRedisTemplate redis;

    @Autowired
    JdbcTemplate jdbc;

    private Set<String> columns(String table) {
        return new TreeSet<>(jdbc.queryForList(
                "select lower(column_name) from information_schema.columns "
                        + "where lower(table_schema) = 'pms' and lower(table_name) = ?", String.class, table));
    }

    private Set<String> notNullColumns(String table) {
        return new TreeSet<>(jdbc.queryForList(
                "select lower(column_name) from information_schema.columns "
                        + "where lower(table_schema) = 'pms' and lower(table_name) = ? and is_nullable = 'NO'",
                String.class, table));
    }

    /** Column sets of every unique constraint / unique index on the table, e.g. "cycle_id,stage". */
    private Set<String> uniqueKeys(String table) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "select lower(tc.constraint_name) as name, lower(kcu.column_name) as col "
                        + "from information_schema.table_constraints tc "
                        + "join information_schema.key_column_usage kcu "
                        + "on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema "
                        + "where lower(tc.table_schema) = 'pms' and lower(tc.table_name) = ? "
                        + "and tc.constraint_type = 'UNIQUE' order by tc.constraint_name, kcu.ordinal_position",
                table);
        java.util.Map<String, java.util.List<String>> byName = new java.util.LinkedHashMap<>();
        for (Map<String, Object> row : rows) {
            byName.computeIfAbsent((String) row.get("name"), k -> new java.util.ArrayList<>())
                    .add((String) row.get("col"));
        }
        Set<String> out = new TreeSet<>();
        byName.values().forEach(cols -> out.add(String.join(",", cols)));
        return out;
    }

    private Set<String> foreignKeys(String table) {
        return new TreeSet<>(jdbc.queryForList(
                "select lower(kcu.column_name) from information_schema.table_constraints tc "
                        + "join information_schema.key_column_usage kcu "
                        + "on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema "
                        + "where lower(tc.table_schema) = 'pms' and lower(tc.table_name) = ? "
                        + "and tc.constraint_type = 'FOREIGN KEY'", String.class, table));
    }

    @Test
    void everyDesignedTableExistsInThePmsSchema() {
        Set<String> tables = new TreeSet<>(jdbc.queryForList(
                "select lower(table_name) from information_schema.tables where lower(table_schema) = 'pms'",
                String.class));
        assertThat(tables).containsExactlyInAnyOrder(
                "pms_cycle", "pms_cycle_stage", "pms_cycle_applicability", "pms_cycle_plant", "pms_cycle_department",
                "pms_cycle_employment_type", "pms_cycle_eligibility_run", "pms_cycle_notification",
                "rating_scale", "rating_scale_level", "goal_template", "kra_master", "kpi_master",
                "competency_master", "standard_rating_level", "goal_template_kra", "goal_template_kpi",
                "goal_template_competency", "goal_assignment", "goal_assignment_target");
    }

    @Test
    void designedColumnsArePresentOnEveryTable() {
        assertThat(columns("pms_cycle")).contains("id", "organisation_id", "cycle_code", "name", "description", "type",
                "period_start", "period_end", "status", "rating_scale_id", "notify_managers", "notify_employees",
                "notify_hod", "notify_hr", "current_step", "completed_step", "published_on", "created_by",
                "modified_by", "created_date", "modified_date");
        assertThat(columns("pms_cycle_stage")).contains("id", "cycle_id", "stage", "start_date", "end_date",
                "notification_enabled", "created_by", "modified_by", "created_date", "modified_date");
        assertThat(columns("pms_cycle_applicability")).contains("id", "cycle_id", "all_plants", "all_departments",
                "minimum_service_months", "service_calculated_as_on", "exclude_probation", "exclude_notice_period");
        assertThat(columns("pms_cycle_plant")).contains("id", "cycle_id", "plant_id", "created_date");
        assertThat(columns("pms_cycle_department")).contains("id", "cycle_id", "department_id", "created_date");
        assertThat(columns("pms_cycle_employment_type")).contains("id", "cycle_id", "employment_type", "created_date");
        assertThat(columns("pms_cycle_eligibility_run")).contains("id", "cycle_id", "status", "started_on",
                "completed_on", "total_eligible", "excluded_probation", "excluded_notice_period",
                "excluded_min_service", "error_message", "created_date");
        assertThat(columns("pms_cycle_notification")).contains("id", "cycle_id", "audience", "sent_count", "status",
                "sent_on", "error_message", "created_date");
        assertThat(columns("rating_scale")).contains("id", "organisation_id", "name", "description", "status",
                "is_default", "show_definitions_to_employees", "created_by", "modified_by", "created_date",
                "modified_date");
        assertThat(columns("rating_scale_level")).contains("id", "rating_scale_id", "rating_value", "label",
                "definition", "minimum_score", "maximum_score", "colour_code", "display_order", "created_date",
                "modified_date");
        assertThat(columns("goal_template")).contains("id", "organisation_id", "financial_year", "template_name",
                "description", "department_id", "role_id", "plant_id", "effective_from", "status", "created_by",
                "modified_by", "created_date", "modified_date");
        assertThat(columns("kra_master")).contains("id", "organisation_id", "name", "status", "created_by",
                "modified_by", "created_date", "modified_date");
        assertThat(columns("kpi_master")).contains("id", "organisation_id", "kra_id", "name", "unit", "target_type",
                "expected_outcome", "evidence_required", "status", "created_by", "modified_by", "created_date",
                "modified_date");
        assertThat(columns("competency_master")).contains("id", "organisation_id", "name", "category", "status",
                "created_by", "modified_by", "created_date", "modified_date");
        assertThat(columns("goal_template_kra")).contains("id", "template_id", "kra_id", "display_order",
                "created_date");
        assertThat(columns("goal_template_kpi")).contains("id", "template_id", "kra_id", "kpi_id", "weightage",
                "target_type", "display_order", "created_date", "modified_date");
        assertThat(columns("goal_template_competency")).contains("id", "template_id", "competency_id", "weightage",
                "display_order", "created_date", "modified_date");
    }

    @Test
    void notNullRulesFollowTheDesign() {
        assertThat(notNullColumns("pms_cycle")).contains("organisation_id", "cycle_code", "name", "type",
                "period_start", "period_end", "status", "notify_managers", "notify_employees", "notify_hod",
                "notify_hr", "current_step", "completed_step").doesNotContain("rating_scale_id", "published_on",
                "description");
        assertThat(notNullColumns("pms_cycle_stage")).contains("cycle_id", "stage", "notification_enabled")
                .doesNotContain("start_date", "end_date");
        assertThat(notNullColumns("pms_cycle_eligibility_run")).contains("cycle_id", "status", "started_on",
                "total_eligible").doesNotContain("completed_on", "error_message");
        assertThat(notNullColumns("goal_template")).contains("organisation_id", "financial_year", "template_name",
                "department_id", "role_id", "effective_from", "status").doesNotContain("plant_id", "description");
        assertThat(notNullColumns("kpi_master")).contains("kra_id", "name", "unit", "target_type", "status")
                .doesNotContain("expected_outcome", "evidence_required");
        assertThat(notNullColumns("goal_template_kpi")).contains("template_id", "kra_id", "kpi_id", "weightage",
                "target_type");
    }

    @Test
    void uniqueKeysFollowTheDesign() {
        assertThat(uniqueKeys("pms_cycle")).contains("cycle_code");
        assertThat(uniqueKeys("pms_cycle_stage")).contains("cycle_id,stage");
        assertThat(uniqueKeys("pms_cycle_applicability")).contains("cycle_id");
        assertThat(uniqueKeys("pms_cycle_plant")).contains("cycle_id,plant_id");
        assertThat(uniqueKeys("pms_cycle_department")).contains("cycle_id,department_id");
        assertThat(uniqueKeys("pms_cycle_employment_type")).contains("cycle_id,employment_type");
        assertThat(uniqueKeys("rating_scale_level")).contains("rating_scale_id,rating_value");
        assertThat(uniqueKeys("goal_template_kra")).contains("template_id,kra_id");
        assertThat(uniqueKeys("goal_template_kpi")).contains("template_id,kpi_id");
        assertThat(uniqueKeys("goal_template_competency")).contains("template_id,competency_id");
    }

    @Test
    void foreignKeysFollowTheRelationshipsInTheDesign() {
        for (String child : List.of("pms_cycle_stage", "pms_cycle_applicability", "pms_cycle_plant",
                "pms_cycle_department", "pms_cycle_employment_type", "pms_cycle_eligibility_run",
                "pms_cycle_notification")) {
            assertThat(foreignKeys(child)).as(child).containsExactly("cycle_id");
        }
        assertThat(foreignKeys("rating_scale_level")).containsExactly("rating_scale_id");
        assertThat(foreignKeys("kpi_master")).containsExactly("kra_id");
        assertThat(foreignKeys("goal_template_kra")).containsExactlyInAnyOrder("template_id", "kra_id");
        assertThat(foreignKeys("goal_template_kpi")).containsExactlyInAnyOrder("template_id", "kra_id", "kpi_id");
        assertThat(foreignKeys("goal_template_competency")).containsExactlyInAnyOrder("template_id",
                "competency_id");
    }
}
