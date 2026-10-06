package com.sentrifugo.pms.service;

import com.sentrifugo.common.exception.DomainException;
import com.sentrifugo.db.dto.PmsGoalTemplateCompetencyDTO;
import com.sentrifugo.db.dto.PmsGoalTemplateDTO;
import com.sentrifugo.db.dto.PmsGoalTemplateKpiDTO;
import com.sentrifugo.db.dto.PmsGoalTemplateKraDTO;
import com.sentrifugo.db.entity.PmsCompetencyMasterEntity;
import com.sentrifugo.db.entity.PmsGoalTemplateCompetencyEntity;
import com.sentrifugo.db.entity.PmsGoalTemplateEntity;
import com.sentrifugo.db.entity.PmsGoalTemplateKpiEntity;
import com.sentrifugo.db.entity.PmsGoalTemplateKraEntity;
import com.sentrifugo.db.entity.PmsKpiMasterEntity;
import com.sentrifugo.db.entity.PmsKraMasterEntity;
import com.sentrifugo.db.enums.PmsMasterStatus;
import com.sentrifugo.db.enums.PmsTargetType;
import com.sentrifugo.db.enums.PmsTemplateStatus;
import com.sentrifugo.db.mapper.PmsGoalTemplateCompetencyMapper;
import com.sentrifugo.db.mapper.PmsGoalTemplateKpiMapper;
import com.sentrifugo.db.mapper.PmsGoalTemplateKraMapper;
import com.sentrifugo.db.mapper.PmsGoalTemplateMapper;
import com.sentrifugo.db.repository.PmsCompetencyMasterRepository;
import com.sentrifugo.db.repository.PmsGoalTemplateCompetencyRepository;
import com.sentrifugo.db.repository.PmsGoalTemplateKpiRepository;
import com.sentrifugo.db.repository.PmsGoalTemplateKraRepository;
import com.sentrifugo.db.repository.PmsGoalTemplateRepository;
import com.sentrifugo.db.repository.PmsKpiMasterRepository;
import com.sentrifugo.db.repository.PmsKraMasterRepository;
import com.sentrifugo.db.util.PmsGoalTemplateSpecifications;
import com.sentrifugo.pms.model.PmsGoalTemplateCompetencyRequest;
import com.sentrifugo.pms.model.PmsGoalTemplateKraKpiRequest;
import com.sentrifugo.pms.model.PmsGoalTemplateListResponse;
import com.sentrifugo.pms.model.PmsGoalTemplateRequest;
import com.sentrifugo.pms.model.PmsGoalTemplateResponse;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Goal templates (screens 2.1-2.4), saved the way the three-step wizard saves them: basic info, then the KRA/KPI
 * selection, then the competencies, each as one transactional replace.
 *
 * <p>A template is "complete" when every selected KRA has KPIs whose weights total 100 and the competency weights
 * total 100. An ACTIVE template must be complete: it starts as DRAFT, is promoted to ACTIVE when the final step
 * is saved complete (unless it was marked inactive), and falls back to DRAFT if a later edit makes it incomplete.
 * Department, role and plant ids come from the Sentrifugo system and cannot be checked here.
 */
@Service
@RequiredArgsConstructor
public class PmsGoalTemplateService {

    private static final Logger log = LoggerFactory.getLogger(PmsGoalTemplateService.class);
    private static final BigDecimal HUNDRED = new BigDecimal("100");
    private static final BigDecimal TOLERANCE = new BigDecimal("0.01");

    private final PmsGoalTemplateRepository templateRepository;
    private final PmsGoalTemplateKraRepository templateKraRepository;
    private final PmsGoalTemplateKpiRepository templateKpiRepository;
    private final PmsGoalTemplateCompetencyRepository templateCompetencyRepository;
    private final PmsKraMasterRepository kraRepository;
    private final PmsKpiMasterRepository kpiRepository;
    private final PmsCompetencyMasterRepository competencyRepository;
    private final PmsGoalTemplateMapper templateMapper;
    private final PmsGoalTemplateKraMapper templateKraMapper;
    private final PmsGoalTemplateKpiMapper templateKpiMapper;
    private final PmsGoalTemplateCompetencyMapper templateCompetencyMapper;

    // ── Reads ────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public List<PmsGoalTemplateListResponse> getGoalTemplates(String organisationId, String financialYear,
                                                              String departmentId, String plantId, String search) {
        var spec = PmsGoalTemplateSpecifications.matching(organisationId, financialYear, departmentId, plantId,
                search);
        return templateRepository.findAll(spec, Sort.by(Sort.Direction.DESC, "createdDate")).stream()
                .map(t -> new PmsGoalTemplateListResponse(t.getId(), t.getTemplateName(), t.getFinancialYear(),
                        t.getDepartmentId(), t.getRoleId(), t.getPlantId(), t.getEffectiveFrom(), wire(t.getStatus())))
                .toList();
    }

    @Transactional(readOnly = true)
    public PmsGoalTemplateResponse getGoalTemplate(String organisationId, UUID templateId) {
        return toResponse(find(organisationId, templateId));
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /** Screen 2.2 "Save and Next". */
    @Transactional
    public PmsGoalTemplateResponse createGoalTemplate(String organisationId, PmsGoalTemplateRequest request) {
        log.info("Creating goal template for organisation {}", organisationId);
        PmsTemplateStatus status = initialStatus(request.status());
        PmsGoalTemplateEntity template = templateMapper.toEntity(PmsGoalTemplateDTO.builder()
                .organisationId(organisationId)
                .financialYear(request.financialYear().trim())
                .templateName(request.templateName().trim())
                .description(request.description())
                .departmentId(request.departmentId())
                .roleId(request.roleId())
                .plantId(request.plantId())
                .effectiveFrom(request.effectiveFrom())
                .status(status)
                .build());
        return toResponse(templateRepository.save(template));
    }

    @Transactional
    public PmsGoalTemplateResponse updateGoalTemplate(String organisationId, UUID templateId,
                                                      PmsGoalTemplateRequest request) {
        log.info("Updating goal template {}", templateId);
        PmsGoalTemplateEntity template = find(organisationId, templateId);
        template.setFinancialYear(request.financialYear().trim());
        template.setTemplateName(request.templateName().trim());
        template.setDescription(request.description());
        template.setDepartmentId(request.departmentId());
        template.setRoleId(request.roleId());
        template.setPlantId(request.plantId());
        template.setEffectiveFrom(request.effectiveFrom());
        PmsTemplateStatus requested = initialStatus(request.status());
        // Marking a template active only sticks while it is complete (see the class comment).
        template.setStatus(requested == PmsTemplateStatus.DRAFT && request.status() != null
                && request.status().equalsIgnoreCase("active") && isComplete(templateId)
                ? PmsTemplateStatus.ACTIVE : requested);
        return toResponse(templateRepository.save(template));
    }

    /** Screen 2.3 "Save as Draft" / "Save and Next": replaces the template's KRA and KPI selection. */
    @Transactional
    public PmsGoalTemplateResponse saveKraKpi(String organisationId, UUID templateId,
                                              PmsGoalTemplateKraKpiRequest request) {
        log.info("Saving KRA/KPI configuration of goal template {}", templateId);
        PmsGoalTemplateEntity template = find(organisationId, templateId);
        boolean draft = Boolean.TRUE.equals(request.saveAsDraft());

        Map<UUID, PmsKraMasterEntity> kras = new LinkedHashMap<>();
        Map<UUID, PmsKpiMasterEntity> kpis = new LinkedHashMap<>();
        BigDecimal total = BigDecimal.ZERO;
        Set<UUID> seenKras = new HashSet<>();
        Set<UUID> seenKpis = new HashSet<>();

        if (!draft && request.kras().isEmpty()) {
            throw DomainException.unprocessable("Select at least one KRA.", "PMS_TEMPLATE_INCOMPLETE");
        }
        for (PmsGoalTemplateKraKpiRequest.Kra kraRequest : request.kras()) {
            if (!seenKras.add(kraRequest.kraId())) {
                throw DomainException.unprocessable("Each KRA may only be added once.", "VALIDATION_ERROR");
            }
            PmsKraMasterEntity kra = kraRepository.findByIdAndOrganisationId(kraRequest.kraId(), organisationId)
                    .filter(k -> Boolean.TRUE.equals(k.getIsActive()) && k.getStatus() == PmsMasterStatus.ACTIVE)
                    .orElseThrow(() -> DomainException.unprocessable(
                            "kra_id " + kraRequest.kraId() + " does not refer to an active KRA", "PMS_KRA_NOT_FOUND"));
            kras.put(kra.getId(), kra);
            if (!draft && kraRequest.kpis().isEmpty()) {
                throw DomainException.unprocessable("Every selected KRA needs at least one KPI.",
                        "PMS_TEMPLATE_INCOMPLETE");
            }
            for (PmsGoalTemplateKraKpiRequest.Kpi kpiRequest : kraRequest.kpis()) {
                if (!seenKpis.add(kpiRequest.kpiId())) {
                    throw DomainException.unprocessable("Each KPI may only be added once.", "VALIDATION_ERROR");
                }
                PmsKpiMasterEntity kpi = kpiRepository.findByIdAndOrganisationId(kpiRequest.kpiId(), organisationId)
                        .filter(k -> Boolean.TRUE.equals(k.getIsActive()) && k.getStatus() == PmsMasterStatus.ACTIVE)
                        .orElseThrow(() -> DomainException.unprocessable(
                                "kpi_id " + kpiRequest.kpiId() + " does not refer to an active KPI",
                                "PMS_KPI_NOT_FOUND"));
                if (!kpi.getKra().getId().equals(kra.getId())) {
                    throw DomainException.unprocessable("KPI '" + kpi.getName() + "' does not belong to KRA '"
                            + kra.getName() + "'.", "VALIDATION_ERROR");
                }
                kpis.put(kpi.getId(), kpi);
                total = total.add(kpiRequest.weightage());
            }
        }
        if (total.compareTo(HUNDRED.add(TOLERANCE)) > 0) {
            throw DomainException.unprocessable("KPI weightage cannot exceed 100 (got " + total + ").",
                    "PMS_TEMPLATE_INCOMPLETE");
        }
        if (!draft && total.subtract(HUNDRED).abs().compareTo(TOLERANCE) > 0) {
            throw DomainException.unprocessable("KPI weightage must total 100 (got " + total + ").",
                    "PMS_TEMPLATE_INCOMPLETE");
        }

        templateKpiRepository.deleteByTemplateId(templateId);
        templateKraRepository.deleteByTemplateId(templateId);
        templateKpiRepository.flush();
        int kraOrder = 0;
        for (PmsGoalTemplateKraKpiRequest.Kra kraRequest : request.kras()) {
            PmsKraMasterEntity kra = kras.get(kraRequest.kraId());
            PmsGoalTemplateKraEntity row = templateKraMapper.toEntity(
                    PmsGoalTemplateKraDTO.builder().displayOrder(kraOrder++).build());
            row.setTemplate(template);
            row.setKra(kra);
            templateKraRepository.save(row);
            int kpiOrder = 0;
            for (PmsGoalTemplateKraKpiRequest.Kpi kpiRequest : kraRequest.kpis()) {
                PmsKpiMasterEntity kpi = kpis.get(kpiRequest.kpiId());
                PmsGoalTemplateKpiEntity kpiRow = templateKpiMapper.toEntity(PmsGoalTemplateKpiDTO.builder()
                        .weightage(kpiRequest.weightage())
                        .targetType(kpiRequest.targetType() == null || kpiRequest.targetType().isBlank()
                                ? kpi.getTargetType() : parseTargetType(kpiRequest.targetType()))
                        .displayOrder(kpiOrder++)
                        .build());
                kpiRow.setTemplate(template);
                kpiRow.setKra(kra);
                kpiRow.setKpi(kpi);
                templateKpiRepository.save(kpiRow);
            }
        }
        templateKpiRepository.flush();
        demoteIfIncomplete(template);
        return toResponse(template);
    }

    /** Screen 2.4 "Save": replaces the competency selection; when non-empty it must total 100. */
    @Transactional
    public PmsGoalTemplateResponse saveCompetencies(String organisationId, UUID templateId,
                                                    PmsGoalTemplateCompetencyRequest request) {
        log.info("Saving competencies of goal template {}", templateId);
        PmsGoalTemplateEntity template = find(organisationId, templateId);
        Map<UUID, PmsCompetencyMasterEntity> competencies = new LinkedHashMap<>();
        BigDecimal total = BigDecimal.ZERO;
        for (PmsGoalTemplateCompetencyRequest.Item item : request.competencies()) {
            if (competencies.containsKey(item.competencyId())) {
                throw DomainException.unprocessable("Each competency may only be added once.", "VALIDATION_ERROR");
            }
            PmsCompetencyMasterEntity competency = competencyRepository
                    .findByIdAndOrganisationId(item.competencyId(), organisationId)
                    .filter(c -> Boolean.TRUE.equals(c.getIsActive()) && c.getStatus() == PmsMasterStatus.ACTIVE)
                    .orElseThrow(() -> DomainException.unprocessable("competency_id " + item.competencyId()
                            + " does not refer to an active competency", "PMS_COMPETENCY_NOT_FOUND"));
            competencies.put(competency.getId(), competency);
            total = total.add(item.weightage());
        }
        // An empty list clears the selection (guide §4.6); the 100% rule applies only when there are rows.
        if (!request.competencies().isEmpty() && total.subtract(HUNDRED).abs().compareTo(TOLERANCE) > 0) {
            throw DomainException.unprocessable("Competency weightage must total 100 (got " + total + ").",
                    "PMS_TEMPLATE_INCOMPLETE");
        }

        templateCompetencyRepository.deleteByTemplateId(templateId);
        templateCompetencyRepository.flush();
        int order = 0;
        for (PmsGoalTemplateCompetencyRequest.Item item : request.competencies()) {
            PmsGoalTemplateCompetencyEntity row = templateCompetencyMapper.toEntity(
                    PmsGoalTemplateCompetencyDTO.builder().weightage(item.weightage()).displayOrder(order++).build());
            row.setTemplate(template);
            row.setCompetency(competencies.get(item.competencyId()));
            templateCompetencyRepository.save(row);
        }
        templateCompetencyRepository.flush();

        // The last wizard step: a complete template that is still a draft becomes active.
        if (template.getStatus() == PmsTemplateStatus.DRAFT && isComplete(templateId)) {
            template.setStatus(PmsTemplateStatus.ACTIVE);
            templateRepository.save(template);
        }
        return toResponse(template);
    }

    // ── internals ────────────────────────────────────────────────────────────

    private PmsGoalTemplateEntity find(String organisationId, UUID templateId) {
        return templateRepository.findByIdAndOrganisationId(templateId, organisationId)
                .filter(t -> Boolean.TRUE.equals(t.getIsActive()))
                .orElseThrow(() -> DomainException.notFound("Goal template not found", "PMS_TEMPLATE_NOT_FOUND"));
    }

    /** {@code inactive} is kept; anything else (including active) starts as a draft until the template is complete. */
    private static PmsTemplateStatus initialStatus(String requested) {
        if (requested == null || requested.isBlank()) {
            return PmsTemplateStatus.DRAFT;
        }
        try {
            PmsTemplateStatus status = PmsTemplateStatus.valueOf(requested.trim().toUpperCase(Locale.ROOT));
            return status == PmsTemplateStatus.INACTIVE ? PmsTemplateStatus.INACTIVE : PmsTemplateStatus.DRAFT;
        } catch (IllegalArgumentException e) {
            throw DomainException.unprocessable("status must be one of: draft, active, inactive",
                    "VALIDATION_ERROR");
        }
    }

    private void demoteIfIncomplete(PmsGoalTemplateEntity template) {
        if (template.getStatus() == PmsTemplateStatus.ACTIVE && !isComplete(template.getId())) {
            template.setStatus(PmsTemplateStatus.DRAFT);
            templateRepository.save(template);
        }
    }

    /** Every selected KRA has KPIs, KPI weights total 100, and competency weights total 100. */
    private boolean isComplete(UUID templateId) {
        List<PmsGoalTemplateKraEntity> kras = templateKraRepository.findByTemplateIdOrderByDisplayOrderAsc(templateId);
        List<PmsGoalTemplateKpiEntity> kpis = templateKpiRepository.findByTemplateIdOrderByDisplayOrderAsc(templateId);
        if (kras.isEmpty()) {
            return false;
        }
        Set<UUID> krasWithKpis = new HashSet<>();
        kpis.forEach(k -> krasWithKpis.add(k.getKra().getId()));
        if (!kras.stream().allMatch(k -> krasWithKpis.contains(k.getKra().getId()))) {
            return false;
        }
        BigDecimal kpiTotal = kpis.stream().map(PmsGoalTemplateKpiEntity::getWeightage)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal competencyTotal = templateCompetencyRepository.findByTemplateIdOrderByDisplayOrderAsc(templateId)
                .stream().map(PmsGoalTemplateCompetencyEntity::getWeightage).reduce(BigDecimal.ZERO, BigDecimal::add);
        return kpiTotal.subtract(HUNDRED).abs().compareTo(TOLERANCE) <= 0
                && competencyTotal.subtract(HUNDRED).abs().compareTo(TOLERANCE) <= 0;
    }

    private static PmsTargetType parseTargetType(String value) {
        try {
            return PmsTargetType.valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw DomainException.unprocessable("target_type must be one of: individual, common",
                    "VALIDATION_ERROR");
        }
    }

    private PmsGoalTemplateResponse toResponse(PmsGoalTemplateEntity template) {
        UUID id = template.getId();
        Map<UUID, List<PmsGoalTemplateResponse.Kpi>> kpisByKra = new LinkedHashMap<>();
        BigDecimal kpiTotal = BigDecimal.ZERO;
        for (PmsGoalTemplateKpiEntity row : templateKpiRepository.findByTemplateIdOrderByDisplayOrderAsc(id)) {
            PmsKpiMasterEntity kpi = row.getKpi();
            kpisByKra.computeIfAbsent(row.getKra().getId(), k -> new ArrayList<>())
                    .add(new PmsGoalTemplateResponse.Kpi(kpi.getId(), kpi.getName(), kpi.getUnit(), row.getWeightage(),
                            wire(row.getTargetType()), kpi.getExpectedOutcome(), kpi.getEvidenceRequired()));
            kpiTotal = kpiTotal.add(row.getWeightage());
        }
        List<PmsGoalTemplateResponse.Kra> kras = templateKraRepository.findByTemplateIdOrderByDisplayOrderAsc(id)
                .stream()
                .map(r -> new PmsGoalTemplateResponse.Kra(r.getKra().getId(), r.getKra().getName(),
                        kpisByKra.getOrDefault(r.getKra().getId(), List.of())))
                .toList();

        BigDecimal competencyTotal = BigDecimal.ZERO;
        List<PmsGoalTemplateResponse.Competency> competencies = new ArrayList<>();
        for (PmsGoalTemplateCompetencyEntity row : templateCompetencyRepository
                .findByTemplateIdOrderByDisplayOrderAsc(id)) {
            PmsCompetencyMasterEntity c = row.getCompetency();
            competencies.add(new PmsGoalTemplateResponse.Competency(c.getId(), c.getName(), c.getCategory(),
                    row.getWeightage()));
            competencyTotal = competencyTotal.add(row.getWeightage());
        }
        return new PmsGoalTemplateResponse(id, template.getFinancialYear(), template.getTemplateName(),
                template.getDescription(), template.getDepartmentId(), template.getRoleId(), template.getPlantId(),
                template.getEffectiveFrom(), wire(template.getStatus()), kras, competencies, kpiTotal,
                competencyTotal);
    }

    private static String wire(Enum<?> value) {
        return value == null ? null : value.name().toLowerCase(Locale.ROOT);
    }
}
